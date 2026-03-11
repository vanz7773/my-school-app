const School = require("../models/School");
const User = require("../models/User");
const Student = require("../models/Student");
const SchoolTransaction = require("../models/SchoolTransaction");
const SchoolInfo = require("../models/SchoolInfo");
const Notification = require("../models/Notification");
const { broadcastNotification } = require("./notificationController");

// Helper error sender
const sendError = (res, code, message) =>
    res.status(code).json({ success: false, message });

exports.getAllSchools = async (req, res) => {
    try {
        // Basic pagination (optional, but good practice)
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100; // default large limit for now

        const skip = (page - 1) * limit;

        const schools = await School.find()
            .sort({ createdAt: -1 }) // newest first
            .skip(skip)
            .limit(limit)
            .lean();

        const total = await School.countDocuments();

        // Enrich with stats if needed (students count, teachers count)
        // This could be slow if database is huge, but for now okay.
        // Parallelizing the count queries would be better.
        const enrichedSchools = await Promise.all(
            schools.map(async (school) => {
                const studentCount = await Student.countDocuments({ school: school._id });
                const teacherCount = await User.countDocuments({ school: school._id, role: "teacher" });
                const adminCount = await User.countDocuments({ school: school._id, role: "admin" });

                // Calculate owing subscription status
                const pendingInvoices = await SchoolTransaction.find({
                    school: school._id,
                    type: 'invoice',
                    status: 'pending'
                }).sort({ dueDate: 1 }); // Sort by due date ascending (oldest first)

                let owingBalance = 0;
                let nextDueDate = null;

                if (pendingInvoices.length > 0) {
                    owingBalance = pendingInvoices.reduce((sum, inv) => sum + (inv.amount || 0), 0);
                    // Find the first valid due date
                    const invoiceWithDate = pendingInvoices.find(inv => inv.dueDate);
                    if (invoiceWithDate) {
                        nextDueDate = invoiceWithDate.dueDate;
                    }
                }

                return {
                    ...school,
                    stats: {
                        students: studentCount,
                        teachers: teacherCount,
                        admins: adminCount
                    },
                    subscription: {
                        isOwing: owingBalance > 0,
                        owingBalance,
                        nextDueDate
                    }
                };
            })
        );

        return res.json({
            success: true,
            count: total,
            schools: enrichedSchools,
            page,
            totalPages: Math.ceil(total / limit),
        });
    } catch (err) {
        console.error("Values error in getAllSchools:", err);
        return sendError(res, 500, "Server error fetching schools");
    }
};

exports.alertOwingSchool = async (req, res) => {
    try {
        const { id } = req.params;

        const school = await School.findById(id);
        if (!school) {
            return sendError(res, 404, "School not found");
        }

        // Calculate owing status to include in the notification
        const pendingInvoices = await SchoolTransaction.find({
            school: id,
            type: 'invoice',
            status: 'pending'
        }).sort({ dueDate: 1 });

        let owingBalance = 0;
        let nextDueDate = null;

        if (pendingInvoices.length > 0) {
            owingBalance = pendingInvoices.reduce((sum, inv) => sum + (inv.amount || 0), 0);
            const invoiceWithDate = pendingInvoices.find(inv => inv.dueDate);
            if (invoiceWithDate) nextDueDate = invoiceWithDate.dueDate;
        }

        if (owingBalance <= 0) {
            return res.status(400).json({ success: false, message: "This school is not currently owing." });
        }

        let message = `URGENT: Your school has an outstanding subscription balance of ₵${owingBalance}.`;
        if (nextDueDate) {
            const formattedDate = new Date(nextDueDate).toLocaleDateString();
            message += ` The payment was due by ${formattedDate}.`;
        }
        message += ` Please arrange for payment to avoid service interruption.`;

        // Send Notification to school admins
        const notification = await Notification.create({
            title: "Outstanding Subscription Access Fee",
            message: message,
            type: "general", // "system" is not a valid enum type in Notification.js
            audience: "admin",
            school: id,
            sender: req.user ? req.user._id : null
        });

        const mockReq = { app: req.app, user: req.user };
        await broadcastNotification(mockReq, notification);

        return res.json({
            success: true,
            message: "Alert notification sent to school admins successfully."
        });
    } catch (err) {
        console.error("Error in alertOwingSchool:", err);
        return sendError(res, 500, "Server error alerting school");
    }
};

exports.updateSchoolStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // 'active' or 'restricted'

        if (!['active', 'restricted'].includes(status)) {
            return sendError(res, 400, "Invalid status. Use 'active' or 'restricted'");
        }

        const school = await School.findByIdAndUpdate(
            id,
            { status },
            { new: true }
        );

        if (!school) {
            return sendError(res, 404, "School not found");
        }

        return res.json({
            success: true,
            message: `School status updated to ${status}`,
            school
        });
    } catch (err) {
        console.error("Error in updateSchoolStatus:", err);
        return sendError(res, 500, "Server error updating status");
    }
};

exports.getSchoolTransactions = async (req, res) => {
    try {
        const { schoolId } = req.params;
        const transactions = await SchoolTransaction.find({ school: schoolId }).sort({ createdAt: -1 }).lean();
        const schoolInfo = await SchoolInfo.findOne({ school: schoolId }).lean();
        return res.json({ success: true, transactions, schoolInfo });
    } catch (err) {
        console.error("Error in getSchoolTransactions:", err);
        return sendError(res, 500, "Server error fetching transactions");
    }
};

exports.createSchoolTransaction = async (req, res) => {
    try {
        const { schoolId } = req.params;
        const { type, amount, description, reference, dueDate, status, items } = req.body;

        if (!['invoice', 'payment'].includes(type)) {
            return sendError(res, 400, "Invalid transaction type");
        }

        const transaction = new SchoolTransaction({
            school: schoolId,
            type,
            amount,
            description,
            reference,
            dueDate,
            status: status || (type === 'payment' ? 'paid' : 'pending'),
            items
        });

        await transaction.save();

        // 🎉 Notify the school admins about the new transaction
        try {
            const docTitle = type === 'invoice' ? 'New Invoice' : 'Payment Receipt';
            const actionText = type === 'invoice' ? 'generated' : 'recorded';

            const notification = await Notification.create({
                title: `${docTitle} ${actionText.charAt(0).toUpperCase() + actionText.slice(1)}`,
                message: `A new ${type} of ₵${amount} has been ${actionText} for your school.`,
                type: 'transaction',
                audience: 'admin',
                school: schoolId,
                sender: req.user ? req.user._id : null
            });
            // Mock a simple req object with available globals if `req` is missing socket data
            const mockReq = { app: req.app, user: req.user };
            await broadcastNotification(mockReq, notification);
        } catch (notifErr) {
            console.error("Failed to send transaction notification:", notifErr);
            // Don't fail the transaction creation if notification fails
        }

        return res.status(201).json({ success: true, transaction });
    } catch (err) {
        console.error("Error in createSchoolTransaction:", err);
        return sendError(res, 500, "Server error creating transaction");
    }
};

exports.updateTransactionStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'paid', 'cancelled'].includes(status)) {
            return sendError(res, 400, "Invalid status");
        }

        const transaction = await SchoolTransaction.findByIdAndUpdate(
            id,
            { status },
            { new: true }
        );

        if (!transaction) return sendError(res, 404, "Transaction not found");

        try {
            // 🎉 Notify the school admins about the new status update
            const docTitle = transaction.type === 'invoice' ? 'Invoice' : 'Payment Receipt';
            let titleMsg = `${docTitle} Status Updated`;
            let msg = `Your ${docTitle} of ₵${transaction.amount} has been updated to ${status}.`;
            if (status === 'paid') {
                titleMsg = `Payment Confirmed`;
                msg = `Thank you! Your ${transaction.type} of ₵${transaction.amount} has been successfully marked as PAID. A receipt is attached in your billing dashboard.`;
            } else if (status === 'cancelled') {
                titleMsg = `${docTitle} Cancelled`;
                msg = `Your ${transaction.type} of ₵${transaction.amount} has been cancelled.`;
            }

            const notification = await Notification.create({
                title: titleMsg,
                message: msg,
                type: 'transaction',
                audience: 'admin',
                school: transaction.school,
                sender: req.user ? req.user._id : null
            });
            // Mock a simple req object with available globals if `req` is missing socket data
            const mockReq = { app: req.app, user: req.user };
            await broadcastNotification(mockReq, notification);
        } catch (notifErr) {
            console.error("Failed to send transaction update notification:", notifErr);
        }

        return res.json({ success: true, transaction });
    } catch (err) {
        console.error("Error in updateTransactionStatus:", err);
        return sendError(res, 500, "Server error updating transaction");
    }
};

