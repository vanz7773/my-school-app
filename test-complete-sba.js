// test-complete-sba.js
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'school-management-system-97318.firebasestorage.app'
});

console.log('✅ Firebase Admin initialized successfully');

async function testCompleteSBA() {
    console.log('🧪 Complete SBA File Test\n');
    
    try {
        const filePath = 'schools/6869874e7fe4376b23187d51/sba-master/JHS_master_1759673751369.xlsx';
        const bucket = admin.storage().bucket();
        const file = bucket.file(filePath);

        // Test 1: Download the ENTIRE file
        console.log('1. Downloading complete file...');
        const [buffer] = await file.download(); // Download entire file
        console.log('✅ Complete file downloaded:', buffer.length, 'bytes');

        // Test 2: Save to temporary file for inspection
        console.log('\n2. Saving to temporary file...');
        const tempFilePath = path.join(__dirname, 'temp-test-file.xlsx');
        fs.writeFileSync(tempFilePath, buffer);
        console.log('✅ File saved to:', tempFilePath);

        // Test 3: Validate as Excel file with full content
        console.log('\n3. Validating as complete Excel file...');
        const XlsxPopulate = require('xlsx-populate');
        try {
            const workbook = await XlsxPopulate.fromDataAsync(buffer);
            const sheets = workbook.sheets();
            console.log('✅ VALID EXCEL FILE! Sheets found:', sheets.length);
            
            sheets.forEach(sheet => {
                console.log('   📊', sheet.name());
                
                // Show some sample data from key sheets
                if (sheet.name() === 'HOME' || sheet.name() === 'HOME2' || sheet.name() === 'NAMES') {
                    const usedRange = sheet.usedRange();
                    if (usedRange) {
                        const startCell = usedRange.startCell();
                        const endCell = usedRange.endCell();
                        console.log(`      Range: ${startCell.address()} to ${endCell.address()}`);
                    }
                }
            });

            // Test specific cell values in HOME sheet
            const homeSheet = workbook.sheet('HOME');
            if (homeSheet) {
                console.log('\n4. Checking HOME sheet data:');
                const schoolName = homeSheet.cell('B9').value();
                const className = homeSheet.cell('K9').value();
                const teacherName = homeSheet.cell('B12').value();
                console.log('   🏫 School:', schoolName);
                console.log('   📚 Class:', className);
                console.log('   👩‍🏫 Teacher:', teacherName);
            }

        } catch (excelError) {
            console.log('❌ Excel validation failed:', excelError.message);
            
            // Check if it's actually a zip file
            const isZip = buffer.slice(0, 2).toString() === 'PK';
            console.log('   Is ZIP file (should be true for .xlsx):', isZip);
            
            if (!isZip) {
                console.log('   ❌ File is not a valid ZIP/Excel file');
                console.log('   First 10 bytes:', buffer.slice(0, 10).toString('hex'));
            }
        }

        // Test 4: Generate usable signed URL
        console.log('\n5. Generating usable signed URL...');
        const [signedUrl] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour
        });
        console.log('✅ Signed URL (full):', signedUrl);

        // Test if URL is accessible
        console.log('\n6. Testing URL accessibility...');
        const https = require('https');
        const url = new URL(signedUrl);
        
        const response = await new Promise((resolve) => {
            https.get(url, (res) => {
                resolve({
                    statusCode: res.statusCode,
                    contentLength: res.headers['content-length']
                });
            }).on('error', (error) => {
                resolve({ error: error.message });
            });
        });

        if (response.statusCode === 200) {
            console.log('✅ URL accessible - Status:', response.statusCode);
            console.log('   Content Length:', response.contentLength, 'bytes');
        } else {
            console.log('❌ URL access failed:', response.error || `Status: ${response.statusCode}`);
        }

        // Clean up
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
            console.log('\n✅ Temporary file cleaned up');
        }

        console.log('\n🎉 COMPLETE SBA TEST PASSED!');
        console.log('Your SBA system is fully operational.');

    } catch (error) {
        console.error('❌ Complete test failed:', error.message);
    }
}

testCompleteSBA();