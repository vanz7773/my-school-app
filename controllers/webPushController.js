const PushToken = require('../models/PushToken');
const webpush = require('web-push');

// Initialize Web Push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
} else {
    console.warn('⚠️ Web Push VAPID keys not set. Web push notifications will not work.');
}

/**
 * Save or update a subscription
 */
exports.subscribe = async (req, res) => {
    try {
        const { subscription, deviceInfo } = req.body;

        // The endpoint is unique per browser+device combination
        const endpoint = subscription.endpoint;

        // Check if token exists
        let existingToken = await PushToken.findOne({ token: endpoint });

        if (existingToken) {
            // Update existing
            existingToken.userId = req.user._id; // Update user if changed
            existingToken.school = req.user.school; // Update school if changed
            existingToken.subscription = subscription;
            existingToken.platform = 'web';
            existingToken.lastSeen = Date.now();
            existingToken.deviceInfo = deviceInfo || existingToken.deviceInfo;
            // If was disabled, re-enable
            existingToken.disabled = false;
            await existingToken.save();

            return res.status(200).json({ success: true, message: 'Subscription updated' });
        } else {
            // Create new
            await PushToken.create({
                userId: req.user._id,
                school: req.user.school,
                token: endpoint,
                platform: 'web',
                subscription: subscription,
                deviceInfo: deviceInfo || {},
                lastSeen: Date.now()
            });

            return res.status(201).json({ success: true, message: 'Subscription created' });
        }
    } catch (err) {
        console.error('Error saving subscription:', err);
        res.status(500).json({ success: false, message: 'Failed to save subscription' });
    }
};

/**
 * Send a test notification (Optional/Admin only)
 */
exports.sendTestNotification = async (req, res) => {
    try {
        const { userId, title, body } = req.body;

        // Find tokens for user
        const tokens = await PushToken.find({ userId, platform: 'web', disabled: { $ne: true } });

        if (tokens.length === 0) {
            return res.status(404).json({ success: false, message: 'No web subscriptions found for user' });
        }

        const payload = JSON.stringify({ title, body });

        const results = await Promise.all(tokens.map(async (tokenDoc) => {
            try {
                await webpush.sendNotification(tokenDoc.subscription, payload);
                return { success: true, id: tokenDoc._id };
            } catch (error) {
                console.error('Error sending push:', error);

                // If 410 Gone, remove/disable token
                if (error.statusCode === 410) {
                    await PushToken.findByIdAndUpdate(tokenDoc._id, { disabled: true });
                }

                return { success: false, id: tokenDoc._id, error: error.message };
            }
        }));

        res.json({ success: true, results });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
};
