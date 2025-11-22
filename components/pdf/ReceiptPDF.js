import React, { useMemo } from 'react';
import { Page, Text, View, Document, StyleSheet, Image, Font } from '@react-pdf/renderer';
import DejaVuSans from '../fonts/dejavu-sans.book.ttf';
import DejaVuSansBold from '../fonts/dejavu-sans.bold.ttf';

// Register fonts
Font.register({
  family: 'dejavu-sans',
  fonts: [
    { src: DejaVuSans, fontWeight: 'normal' },
    { src: DejaVuSansBold, fontWeight: 'bold' }
  ]
});

const CEDI_SYMBOL = '₵';
const formatCurrency = (amount) => `${CEDI_SYMBOL} ${Number(amount || 0).toFixed(2)}`;

const styles = StyleSheet.create({
  page: { 
    padding: 40, 
    fontSize: 12, 
    fontFamily: 'dejavu-sans',
    display: 'flex',
    flexDirection: 'column'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#000',
    borderBottomStyle: 'solid',
    paddingBottom: 10,
  },
  schoolInfo: { flexDirection: 'column', width: '70%' },
  logo: { width: 60, height: 60 },
  title: { 
    fontSize: 16, 
    fontWeight: 'bold', 
    textAlign: 'center', 
    marginVertical: 10,
    textDecoration: 'underline' 
  },
  paymentInfo: { 
    marginBottom: 10,
    padding: 8
  },
  infoRow: { flexDirection: 'row', marginBottom: 4 },
  infoLabel: { width: 100, fontWeight: 'bold' },
  infoValue: { flex: 1 },
  receiptTable: { 
    width: '100%', 
    marginTop: 8, 
    borderWidth: 1, 
    borderColor: '#000'
  },
  tableHeader: { 
    flexDirection: 'row', 
    backgroundColor: '#f0f0f0', 
    fontWeight: 'bold', 
    paddingVertical: 6, 
    paddingHorizontal: 5, 
    borderBottomWidth: 1, 
    borderBottomColor: '#000' 
  },
  tableRow: { 
    flexDirection: 'row', 
    paddingVertical: 4, 
    paddingHorizontal: 5, 
    borderBottomWidth: 1, 
    borderBottomColor: '#ddd' 
  },
  colDesc: { width: '70%', paddingLeft: 5 },
  colAmount: { width: '30%', textAlign: 'right', paddingRight: 5 },
  totalsSection: { 
    marginTop: 12, 
    padding: 8, 
    backgroundColor: '#f8f9fa', 
    borderWidth: 1, 
    borderColor: '#ddd' 
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 4 },
  totalLabel: { fontWeight: 'bold' },
  signatureSection: { 
    marginTop: 30, 
    flexDirection: 'column', 
    alignItems: 'flex-end'
  },
  signatureName: { fontWeight: 'bold', fontSize: 12, marginBottom: 3 },
  signatureTitle: { fontSize: 11, marginBottom: 3 },
  errorText: { color: 'red', fontSize: 14, textAlign: 'center', marginTop: 20 },
  watermark: {
    position: 'absolute',
    top: '35%',
    left: '30%',
    fontSize: 48,
    color: 'rgba(0,0,0,0.1)',
    transform: 'rotate(-45deg)'
  },
  compact: { marginBottom: 2 }
});

const ReceiptPDF = ({ payment, schoolInfo, bill }) => {
  // Memoized image source handlers
  const logoSrc = useMemo(() => {
    if (!schoolInfo?.logo) return null;

    // If logo is a Firebase Storage public URL or signed URL
    if (schoolInfo.logo.startsWith("http")) {
      return schoolInfo.logo;
    }

    // If it's already a data URI
    if (schoolInfo.logo.startsWith("data:")) {
      return schoolInfo.logo;
    }

    // Otherwise treat it as base64 (already stored in DB)
    return `data:image/png;base64,${schoolInfo.logo}`;
  }, [schoolInfo?.logo]);

  const signatureSrc = useMemo(() => {
    const sig = schoolInfo?.headteacherSignature || schoolInfo?.headTeacherSignature;

    if (!sig) return null;

    // Handle Firebase URL or base64
    if (sig.startsWith("http")) {
      return sig;
    }
    
    // Check if it's already a data URI
    if (sig.startsWith("data:")) {
      return sig;
    }
    
    return `data:image/png;base64,${sig}`;
  }, [schoolInfo?.headteacherSignature, schoolInfo?.headTeacherSignature]);

  if (!schoolInfo || !payment) {
    return (
      <Document>
        <Page size="A4" style={styles.page}>
          <Text style={styles.errorText}>{!schoolInfo ? 'School info missing' : 'Payment data missing'}</Text>
        </Page>
      </Document>
    );
  }

  // Use bill prop as primary source, fallback to payment.bill
  const receiptBill = bill || payment.bill || {};
  
  // Get student info from bill if available
  const student = receiptBill.student || payment.student || {};
  const studentName = student?.name || `${student?.firstName || ''} ${student?.lastName || ''}`.trim() || 'N/A';
  
  // Get class info from bill if available
  const classInfo = receiptBill.class || student?.class || {};
  const className = classInfo?.name || 'N/A';

  // Get term and academic year
  const term = receiptBill.term || payment.term || 'N/A';
  const academicYear = receiptBill.academicYear || payment.academicYear || '';
  
  // Format dates
  const paymentDate = payment.date || payment.createdAt ? 
    new Date(payment.date || payment.createdAt).toLocaleDateString('en-GB', { 
      day: '2-digit', 
      month: 'short', 
      year: 'numeric' 
    }) : 'N/A';
    
  const issuedDate = new Date().toLocaleDateString('en-GB', { 
    day: '2-digit', 
    month: 'short', 
    year: 'numeric' 
  });

  // Calculate amounts
  const paymentAmount = Number(payment.amount) || 0;
  const totalAmount = Number(receiptBill.totalAmount) || 0;
  const totalPaid = Number(receiptBill.totalPaid) || 0;
  const currentBalance = totalAmount - totalPaid;

  // Process fee items
  const processedItems = (receiptBill.items || []).map((item, index) => ({
    id: item._id || `item-${index}`,
    name: item.name || `Fee Item ${index + 1}`,
    amount: Number(item.amount) || 0
  }));

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Watermark */}
        <View fixed style={styles.watermark}>
          <Text>OFFICIAL RECEIPT</Text>
        </View>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.schoolInfo}>
            <Text style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 3 }}>
              {schoolInfo.name || schoolInfo.schoolName || 'School Name'}
            </Text>
            <Text style={styles.compact}>{schoolInfo.address || 'N/A'}</Text>
            <Text style={styles.compact}>Tel: {schoolInfo.phone || 'N/A'}</Text>
            <Text style={styles.compact}>Email: {schoolInfo.email || 'N/A'}</Text>
          </View>
          {logoSrc && <Image style={styles.logo} src={logoSrc} />}
        </View>

        <Text style={styles.title}>OFFICIAL PAYMENT RECEIPT</Text>

        {/* Payment Info */}
        <View style={styles.paymentInfo}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Receipt No:</Text>
            <Text style={styles.infoValue}>{payment._id || 'N/A'}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Payment Date:</Text>
            <Text style={styles.infoValue}>{paymentDate}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Issued On:</Text>
            <Text style={styles.infoValue}>{issuedDate}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Student:</Text>
            <Text style={styles.infoValue}>{studentName}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Class:</Text>
            <Text style={styles.infoValue}>{className}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Term:</Text>
            <Text style={styles.infoValue}>{term} {academicYear}</Text>
          </View>
        </View>

        {/* Items Table */}
        {processedItems.length > 0 ? (
          <>
            <View style={styles.receiptTable}>
              <View style={styles.tableHeader}>
                <Text style={styles.colDesc}>ITEM DESCRIPTION</Text>
                <Text style={styles.colAmount}>AMOUNT ({CEDI_SYMBOL})</Text>
              </View>
              {processedItems.map(item => (
                <View key={item.id} style={styles.tableRow}>
                  <Text style={styles.colDesc}>{item.name}</Text>
                  <Text style={styles.colAmount}>{formatCurrency(item.amount)}</Text>
                </View>
              ))}
            </View>

            {/* Totals Section */}
            <View style={styles.totalsSection}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total Bill:</Text>
                <Text style={{ fontWeight: 'bold' }}>{formatCurrency(totalAmount)}</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total Paid (to date):</Text>
                <Text>{formatCurrency(totalPaid)}</Text>
              </View>
              <View style={[styles.totalRow, { marginTop: 8 }]}>
                <Text style={[styles.totalLabel, { fontWeight: 'bold' }]}>Outstanding Balance:</Text>
                <Text style={{ fontWeight: 'bold' }}>{formatCurrency(currentBalance)}</Text>
              </View>
              <View style={[styles.totalRow, { marginTop: 10, paddingTop: 5 }]}>
                <Text style={[styles.totalLabel, { fontWeight: 'bold' }]}>This Payment:</Text>
                <Text style={{ fontWeight: 'bold', fontSize: 13 }}>{formatCurrency(paymentAmount)}</Text>
              </View>
            </View>
          </>
        ) : (
          <View style={{ marginTop: 12, textAlign: 'center' }}>
            <Text>No fee items available for this payment</Text>
          </View>
        )}

        {/* Signature */}
        <View style={styles.signatureSection}>
          {signatureSrc ? (
            <Image 
              style={{ width: 120, height: 40, marginBottom: 8 }} 
              src={signatureSrc} 
            />
          ) : (
            <View style={{ 
              width: 120, 
              height: 1, 
              marginBottom: 25 
            }} />
          )}
          <Text style={styles.signatureName}>
            {schoolInfo.headteacher || schoolInfo.headTeacherName || 'Headteacher Name'}
          </Text>
          <Text style={styles.signatureTitle}>Headteacher</Text>
        </View>
      </Page>
    </Document>
  );
};

export default ReceiptPDF;