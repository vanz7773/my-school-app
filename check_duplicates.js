const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function checkDuplicates() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected');

        const collection = mongoose.connection.collection('pushtokens');

        console.log('--- Checking for ALL duplicates by token ---');
        const pipeline = [
            { $group: { _id: "$token", count: { $sum: 1 }, ids: { $push: "$_id" } } },
            { $match: { count: { $gt: 1 } } }
        ];

        const duplicates = await collection.aggregate(pipeline).toArray();
        console.log(`Found ${duplicates.length} tokens with duplicates.`);

        if (duplicates.length > 0) {
            duplicates.forEach(d => {
                console.log(`Token: ${d._id}, Count: ${d.count}, IDs: ${d.ids.join(', ')}`);
            });
        } else {
            console.log('✅ No duplicates found in raw collection.');
        }

        const tokenToCheck = "ExponentPushToken[k_9zO-KmqhoPp62GrH9O3U]";
        console.log(`--- Diagnostics for problematic token: ${tokenToCheck} ---`);
        const docs = await collection.find({ token: tokenToCheck }).toArray();
        console.log(`Found ${docs.length} documents.`);
        docs.forEach(d => console.log(JSON.stringify(d, null, 2)));

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

checkDuplicates();
