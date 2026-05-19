const axios = require('axios');
const SmsLog = require('../models/SmsLog');
const SchoolSmsSettings = require('../models/SchoolSmsSettings');

const ARKESEL_API_URL = 'https://sms.arkesel.com/sms/api';

// Format Ghana phone number to international format without + sign for Arkesel
// e.g. 024xxxxxxx -> 23324xxxxxxx
const formatPhoneNumber = (phone) => {
  if (!phone) return null;
  let formatted = phone.replace(/\D/g, ''); // remove non-digits
  if (formatted.startsWith('0')) {
    formatted = '233' + formatted.substring(1);
  } else if (formatted.startsWith('+233')) {
    formatted = formatted.substring(1);
  } else if (!formatted.startsWith('233') && formatted.length === 9) {
    formatted = '233' + formatted; // Handle numbers missing leading 0 or 233
  }
  return formatted;
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

      const formattedRecipients = Array.isArray(recipients) 
        ? recipients.map(formatPhoneNumber).filter(Boolean)
        : [formatPhoneNumber(recipients)].filter(Boolean);

      if (formattedRecipients.length === 0) {
        throw new Error('No valid phone numbers after formatting');
      }

      // Check for duplicates in last 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentLogs = await SmsLog.find({
        school: schoolId,
        message,
        sentAt: { $gte: twentyFourHoursAgo },
        recipientPhone: { $in: formattedRecipients }
      });

      const recentPhones = new Set(recentLogs.map(log => log.recipientPhone));
      const newRecipients = formattedRecipients.filter(phone => !recentPhones.has(phone));

      if (newRecipients.length === 0) {
        return { success: true, message: 'All recipients already received this exact message recently. Skipping.' };
      }

      // SAAS BILLING: Check and deduct internal school balance
      if (settings.smsBalance < newRecipients.length) {
        throw new Error(`Insufficient SMS Balance. You need ${newRecipients.length} units but have ${settings.smsBalance}. Please contact the platform admin to top up.`);
      }

      // For V1 API, recipients need to be a comma-separated string
      const recipientsString = newRecipients.join(',');

      // Send via Arkesel V1 API
      const sender = settings.senderId || process.env.ARKESEL_SENDER_ID || 'SCHOOL';
      const encodedMessage = encodeURIComponent(message);
      
      const response = await axios.get(
        `${ARKESEL_API_URL}?action=send-sms&api_key=${apiKey}&to=${recipientsString}&from=${sender}&sms=${encodedMessage}`
      );

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
        skippedCount: formattedRecipients.length - newRecipients.length
      };

    } catch (error) {
      console.error('SMS Send Error:', error.response?.data || error.message);
      
      // Log failure if we got past basic validation
      if (schoolId && recipients && message) {
        const failedPhones = Array.isArray(recipients) ? recipients : [recipients];
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

  async sendSystemSms({ recipients, message, messageType = 'system' }) {
    try {
      const apiKey = process.env.ARKESEL_API_KEY;
      if (!apiKey) throw new Error('ARKESEL_API_KEY is not configured');

      if (!recipients || recipients.length === 0) {
        throw new Error('No valid recipients provided');
      }

      const formattedRecipients = Array.isArray(recipients) 
        ? recipients.map(formatPhoneNumber).filter(Boolean)
        : [formatPhoneNumber(recipients)].filter(Boolean);

      if (formattedRecipients.length === 0) {
        throw new Error('No valid phone numbers after formatting');
      }

      const recipientsString = formattedRecipients.join(',');
      const sender = process.env.ARKESEL_SENDER_ID || 'SYSTEM';
      const encodedMessage = encodeURIComponent(message);
      
      const response = await axios.get(
        `${ARKESEL_API_URL}?action=send-sms&api_key=${apiKey}&to=${recipientsString}&from=${sender}&sms=${encodedMessage}`
      );

      return {
        success: true,
        data: response.data,
        recipientsCount: formattedRecipients.length
      };
    } catch (error) {
      console.error('System SMS Send Error:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new SmsService();
