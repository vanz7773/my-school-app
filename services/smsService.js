const axios = require('axios');
const SmsLog = require('../models/SmsLog');
const SchoolSmsSettings = require('../models/SchoolSmsSettings');

const ARKESEL_API_URL = 'https://sms.arkesel.com/sms/api';
const GHANA_MOBILE_PREFIXES = new Set([
  '20',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '50',
  '53',
  '54',
  '55',
  '56',
  '57',
  '59'
]);

// Format Ghana phone number to international format without + sign for Arkesel.
// Examples: 054xxxxxxx -> 23354xxxxxxx, +23354xxxxxxx -> 23354xxxxxxx
const formatPhoneNumber = (phone) => {
  if (!phone) return null;

  let formatted = String(phone).trim().replace(/\D/g, '');
  if (formatted.startsWith('00')) {
    formatted = formatted.substring(2);
  }
  if (formatted.startsWith('0') && formatted.length === 10) {
    formatted = `233${formatted.substring(1)}`;
  } else if (!formatted.startsWith('233') && formatted.length === 9) {
    formatted = `233${formatted}`;
  }

  if (!/^233\d{9}$/.test(formatted)) return null;

  const mobilePrefix = formatted.slice(3, 5);
  return GHANA_MOBILE_PREFIXES.has(mobilePrefix) ? formatted : null;
};

const normalizeRecipientsWithStats = (recipients) => {
  const rawRecipients = Array.isArray(recipients) ? recipients : [recipients];
  const formattedRecipients = [];
  const invalidRecipients = [];

  rawRecipients.forEach((recipient) => {
    const formatted = formatPhoneNumber(recipient);
    if (formatted) {
      formattedRecipients.push(formatted);
    } else if (recipient) {
      invalidRecipients.push(String(recipient).trim());
    }
  });

  return {
    formattedRecipients: [...new Set(formattedRecipients)],
    invalidRecipients: [...new Set(invalidRecipients)]
  };
};

const normalizeRecipients = (recipients) =>
  normalizeRecipientsWithStats(recipients).formattedRecipients;

const isSuccessfulProviderResponse = (data) => {
  const code = String(data?.code || data?.status || '').toLowerCase();
  const message = String(data?.message || '').toLowerCase();
  return code === 'ok' || code === '1000' || message.includes('successfully sent');
};

class SmsService {
  async getSchoolSettings(schoolId) {
    let settings = await SchoolSmsSettings.findOne({ school: schoolId });
    if (!settings) {
      settings = await SchoolSmsSettings.create({
        school: schoolId,
        smsEnabled: false,
        senderId: process.env.ARKESEL_SENDER_ID || 'SCHOOL_SMS'
      });
    }
    return settings;
  }

  async checkBalance() {
    try {
      const apiKey = process.env.ARKESEL_API_KEY;
      if (!apiKey) throw new Error('ARKESEL_API_KEY is not defined in .env');
      
      const response = await axios.get(`${ARKESEL_API_URL}?action=check-balance&api_key=${apiKey}&response=json`);
      return response.data;
    } catch (error) {
      console.error('Arkesel Check Balance Error:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendSms({ schoolId, recipients, message, messageType }) {
    try {
      const apiKey = process.env.ARKESEL_API_KEY;
      if (!apiKey) throw new Error('ARKESEL_API_KEY is not configured');

      const settings = await this.getSchoolSettings(schoolId);
      if (!settings.smsEnabled) {
        throw new Error('SMS is disabled for this school');
      }

      if (!recipients || recipients.length === 0) {
        throw new Error('No valid recipients provided');
      }

      const { formattedRecipients, invalidRecipients } = normalizeRecipientsWithStats(recipients);

      if (formattedRecipients.length === 0) {
        throw new Error('No valid phone numbers after formatting');
      }

      let newRecipients = formattedRecipients;
      const invalidPhoneCount = invalidRecipients.length;

      if (invalidPhoneCount > 0) {
        console.warn('Skipping invalid SMS phone numbers:', {
          schoolId,
          invalidPhoneCount
        });
      }

      // Report cards may be resent after corrections, so do not suppress repeat report SMS.
      if (messageType !== 'reports') {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentLogs = await SmsLog.find({
          school: schoolId,
          message,
          status: 'sent',
          sentAt: { $gte: twentyFourHoursAgo },
          recipientPhone: { $in: formattedRecipients }
        });

        const recentPhones = new Set(recentLogs.map(log => log.recipientPhone));
        const duplicateRecipients = formattedRecipients.filter(phone => recentPhones.has(phone));
        newRecipients = formattedRecipients.filter(phone => !recentPhones.has(phone));

        if (newRecipients.length === 0) {
          const skippedLogs = duplicateRecipients.map(phone => ({
            school: schoolId,
            recipientPhone: phone,
            message,
            messageType,
            status: 'skipped',
            apiResponse: 'Duplicate SMS skipped. Recipient already received this exact message recently.'
          }));

          if (skippedLogs.length > 0) {
            await SmsLog.insertMany(skippedLogs).catch(console.error);
          }

          return {
            success: true,
            message: 'All recipients already received this exact message recently. Skipping.',
            recipientsCount: 0,
            skippedCount: duplicateRecipients.length,
            invalidPhoneCount
          };
        }
      }

      // SAAS BILLING: Check and deduct internal school balance
      if (settings.smsBalance < newRecipients.length) {
        throw new Error(`Insufficient SMS Balance. You need ${newRecipients.length} units but have ${settings.smsBalance}. Please contact the platform admin to top up.`);
      }

      // For V1 API, recipients need to be a comma-separated string
      const recipientsString = newRecipients.join(',');

      // Send via Arkesel V1 API
      const sender = settings.senderId || process.env.ARKESEL_SENDER_ID || 'SCHOOL';
      const params = new URLSearchParams({
        action: 'send-sms',
        api_key: apiKey,
        to: recipientsString,
        from: sender,
        sms: message
      });
      
      const response = await axios.get(
        `${ARKESEL_API_URL}?${params.toString()}`
      );

      if (!isSuccessfulProviderResponse(response.data)) {
        const providerMessage = response.data?.message || 'SMS provider rejected the request';
        const providerError = new Error(providerMessage);
        providerError.response = { data: response.data };
        providerError.formattedRecipients = newRecipients;
        throw providerError;
      }

      // Log success
      const logsToCreate = newRecipients.map(phone => ({
        school: schoolId,
        recipientPhone: phone,
        message,
        messageType,
        status: 'sent',
        apiResponse: response.data
      }));

      if (logsToCreate.length > 0) {
        await SmsLog.insertMany(logsToCreate);
      }

      // Deduct balance
      settings.smsBalance -= newRecipients.length;
      await settings.save();

      return {
        success: true,
        data: response.data,
        recipientsCount: newRecipients.length,
        skippedCount: formattedRecipients.length - newRecipients.length,
        invalidPhoneCount
      };

    } catch (error) {
      console.error('SMS Send Error:', error.response?.data || error.message);
      
      // Log failure if we got past basic validation
      if (schoolId && recipients && message) {
        const failedPhones = error.formattedRecipients || normalizeRecipients(recipients);
        const logsToCreate = failedPhones.map(phone => ({
          school: schoolId,
          recipientPhone: phone || 'unknown',
          message,
          messageType: messageType || 'custom',
          status: 'failed',
          apiResponse: error.response?.data || error.message
        }));
        await SmsLog.insertMany(logsToCreate).catch(console.error);
      }

      throw error;
    }
  }

  async sendSystemSms({ schoolId, recipients, message, sender, messageType = 'system' }) {
    try {
      const apiKey = process.env.ARKESEL_API_KEY;
      if (!apiKey) throw new Error('ARKESEL_API_KEY is not configured');

      if (!recipients || recipients.length === 0) {
        throw new Error('No valid recipients provided');
      }

      const { formattedRecipients, invalidRecipients } = normalizeRecipientsWithStats(recipients);

      if (formattedRecipients.length === 0) {
        throw new Error('No valid phone numbers after formatting');
      }

      if (invalidRecipients.length > 0) {
        console.warn('Skipping invalid system SMS phone numbers:', {
          schoolId,
          invalidPhoneCount: invalidRecipients.length
        });
      }

      const recipientsString = formattedRecipients.join(',');
      let senderId = sender || process.env.ARKESEL_SENDER_ID || 'SYSTEM';
      // Alphanumeric Sender ID must be max 11 characters
      senderId = String(senderId).trim().substring(0, 11);

      const params = new URLSearchParams({
        action: 'send-sms',
        api_key: apiKey,
        to: recipientsString,
        from: senderId,
        sms: message
      });
      
      const response = await axios.get(
        `${ARKESEL_API_URL}?${params.toString()}`
      );

      if (!isSuccessfulProviderResponse(response.data)) {
        const providerMessage = response.data?.message || 'SMS provider rejected the request';
        const providerError = new Error(providerMessage);
        providerError.response = { data: response.data };
        providerError.formattedRecipients = formattedRecipients;
        throw providerError;
      }

      // Log success to database if schoolId is provided
      if (schoolId) {
        const logsToCreate = formattedRecipients.map(phone => ({
          school: schoolId,
          recipientPhone: phone,
          message,
          messageType,
          status: 'sent',
          apiResponse: response.data
        }));
        await SmsLog.insertMany(logsToCreate).catch(console.error);
      }

      return {
        success: true,
        data: response.data,
        recipientsCount: formattedRecipients.length,
        invalidPhoneCount: invalidRecipients.length
      };
    } catch (error) {
      console.error('System SMS Send Error:', error.response?.data || error.message);
      
      // Log failure to database if schoolId is provided
      if (schoolId && recipients && message) {
        const failedPhones = error.formattedRecipients || normalizeRecipients(recipients);
        const logsToCreate = failedPhones.map(phone => ({
          school: schoolId,
          recipientPhone: phone || 'unknown',
          message,
          messageType,
          status: 'failed',
          apiResponse: error.response?.data || error.message
        }));
        await SmsLog.insertMany(logsToCreate).catch(console.error);
      }

      throw error;
    }
  }
}

module.exports = new SmsService();
