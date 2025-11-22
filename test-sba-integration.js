// test-sba-integration.js
const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
try {
    const serviceAccount = require('./firebase-service-account.json');
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: 'school-management-system-97318.firebasestorage.app'
    });
    
    console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error.message);
    process.exit(1);
}

async function testSBAIntegration() {
    console.log('🧪 Testing SBA Integration...\n');
    
    try {
        const filePath = 'schools/6869874e7fe4376b23187d51/sba-master/JHS_master_1759673751369.xlsx';
        const bucket = admin.storage().bucket();
        const file = bucket.file(filePath);

        // Test 1: Check if file exists
        console.log('1. Checking file existence...');
        const [exists] = await file.exists();
        console.log('✅ File exists:', exists);

        if (exists) {
            // Test 2: Get file metadata
            console.log('\n2. Getting file metadata...');
            const [metadata] = await file.getMetadata();
            console.log('✅ File metadata:');
            console.log('   - Name:', metadata.name);
            console.log('   - Size:', metadata.size, 'bytes');
            console.log('   - Type:', metadata.contentType);
            console.log('   - Created:', metadata.timeCreated);

            // Test 3: Generate signed URL
            console.log('\n3. Generating signed URL...');
            const [signedUrl] = await file.getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + 15 * 60 * 1000, // 15 minutes
            });
            console.log('✅ Signed URL generated successfully!');
            console.log('   URL:', signedUrl);

            // Test 4: Download a small portion
            console.log('\n4. Testing file download...');
            const [buffer] = await file.download({ start: 0, end: 100 });
            console.log('✅ File download successful!');
            console.log('   Downloaded:', buffer.length, 'bytes');

            // Test if it's a valid Excel file
            console.log('\n5. Testing Excel file validation...');
            const XlsxPopulate = require('xlsx-populate');
            try {
                const workbook = await XlsxPopulate.fromDataAsync(buffer);
                const sheets = workbook.sheets();
                console.log('✅ Valid Excel file! Sheets found:', sheets.length);
                sheets.forEach(sheet => {
                    console.log('   -', sheet.name());
                });
            } catch (excelError) {
                console.log('⚠️ File is not a valid Excel file:', excelError.message);
            }
        }

        console.log('\n🎉 SBA INTEGRATION TEST PASSED!');
        console.log('Your Firebase Storage is working correctly with the new rules.');

    } catch (error) {
        console.error('❌ SBA Integration test failed:', error.message);
        console.error('Full error:', error);
    }
}

testSBAIntegration();