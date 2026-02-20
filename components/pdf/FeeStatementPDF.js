import React, { useMemo } from 'react';
import { Page, Text, View, Document, StyleSheet, Image, Font } from '@react-pdf/renderer';
import DejaVuSans from '../fonts/dejavu-sans.book.ttf';
import DejaVuSansBold from '../fonts/dejavu-sans.bold.ttf';

// Register fonts (outside component)
Font.register({
  family: 'dejavu-sans',
  fonts: [
    { src: DejaVuSans, fontWeight: 'normal' },
    { src: DejaVuSansBold, fontWeight: 'bold' }
  ]
});

const CEDI_SYMBOL = '₵';
const formatCurrency = (amount) => `${CEDI_SYMBOL} ${Number(amount || 0).toFixed(2)}`;

// Static styles
const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 12, fontFamily: 'dejavu-sans' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20, borderBottomWidth: 1, borderBottomColor: '#000', borderBottomStyle: 'solid', paddingBottom: 10 },
  schoolInfo: { flexDirection: 'column', width: '70%' },
  logo: { width: 60, height: 60 },
  title: { fontSize: 16, fontWeight: 'bold', textAlign: 'center', marginVertical: 15, textDecoration: 'underline', fontFamily: 'dejavu-sans' },
  studentInfo: { marginBottom: 15 },
  infoRow: { flexDirection: 'row', marginBottom: 5 },
  infoLabel: { width: 100, fontWeight: 'bold' },
  infoValue: { flex: 1 },
  feeTable: { width: '100%', marginTop: 10, borderWidth: 1, borderColor: '#000', borderStyle: 'solid', borderRadius: 4 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#2c3e50', color: '#fff', fontWeight: 'bold', paddingVertical: 8, paddingHorizontal: 5 },
  tableRow: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 5, borderBottomWidth: 1, borderBottomColor: '#ddd' },
  col1: { width: '10%', textAlign: 'center' },
  col2: { width: '60%', paddingLeft: 5 },
  col3: { width: '30%', textAlign: 'right', paddingRight: 5 },
  totalRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 8, paddingHorizontal: 5, fontWeight: 'bold', backgroundColor: '#f8f9fa', borderTopWidth: 1, borderTopColor: '#000' },
  signatureSection: {
    marginTop: 40,
    width: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end' // This is the key change to right-align
  },
  signatureLine: {
    width: 200,
    borderTopWidth: 1,
    borderTopColor: '#000',
    borderTopStyle: 'solid',
    marginBottom: 5,
    alignSelf: 'flex-end' // Aligns just this element to the right
  },
  signatureName: {
    fontWeight: 'bold',
    fontSize: 12,
    marginBottom: 3,
    textAlign: 'right' // Right-align text
  },
  signatureTitle: {
    fontSize: 11,
    marginBottom: 3,
    textAlign: 'right' // Right-align text
  }
});


const FeeStatementPDF = React.memo(({ student: studentProp, bill, schoolInfo }) => {
  // All hooks called unconditionally at the top
  const student = useMemo(() => bill?.student || studentProp, [bill, studentProp]);

  const studentName = useMemo(() => (
    student?.user?.name ||
    student?.name ||
    `${student?.firstName || ''} ${student?.lastName || ''}`.trim() ||
    'N/A'
  ), [student]);

  const className = useMemo(() => (
    bill?.class?.name ||
    student?.class?.name ||
    student?.currentClass?.name ||
    'N/A'
  ), [bill, student]);

  const termInfo = useMemo(() => (
    bill?.term ? `${bill.term}, ${bill.academicYear}` : 'N/A'
  ), [bill]);

  const dateIssued = useMemo(() => (
    bill?.createdAt
      ? new Date(bill.createdAt).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      })
      : 'N/A'
  ), [bill?.createdAt]);

  const logoSrc = useMemo(() => {
    if (!schoolInfo?.logo) return null;

    // If logo is a Firebase Storage public URL or signed URL
    if (schoolInfo.logo.startsWith("http")) {
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

  const processedItems = useMemo(() => (
    (bill?.items || []).map((item, i) => ({
      sn: i + 1,
      description: item.name || `Fee Item ${i + 1}`,
      formattedAmount: formatCurrency(item.amount)
    }))
  ), [bill?.items]);

  const totalAmount = useMemo(() => (
    formatCurrency(bill?.totalAmount)
  ), [bill?.totalAmount]);

  // Error handling after hooks
  if (!schoolInfo) {
    return (
      <Document>
        <Page size="A4" style={styles.page}>
          <Text style={styles.errorText}>No school information provided</Text>
        </Page>
      </Document>
    );
  }

  if (!bill && !studentProp) {
    return (
      <Document>
        <Page size="A4" style={styles.page}>
          <Text style={styles.errorText}>No student information provided</Text>
        </Page>
      </Document>
    );
  }

  // Main JSX
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.schoolInfo}>
            <Text style={{ fontWeight: 'bold' }}>
              {schoolInfo.name || schoolInfo.schoolName || 'School Name'}
            </Text>
            <Text>Address: {schoolInfo.address || 'N/A'}</Text>
            <Text>TEL: {schoolInfo.phone || 'N/A'}</Text>
            <Text>EMAIL: {schoolInfo.email || 'N/A'}</Text>
            {schoolInfo.motto && (
              <Text style={{ marginTop: 4 }}>
                Motto: {schoolInfo.motto}
              </Text>
            )}
          </View>
          {logoSrc && <Image style={styles.logo} src={logoSrc} />}
        </View>

        <Text style={styles.title}>STUDENT FEE STATEMENT</Text>

        {/* Student Info */}
        <View style={styles.studentInfo}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Student Name:</Text>
            <Text style={styles.infoValue}>{studentName}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Class:</Text>
            <Text style={styles.infoValue}>{className}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Term:</Text>
            <Text style={styles.infoValue}>{termInfo}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Date Issued:</Text>
            <Text style={styles.infoValue}>{dateIssued}</Text>
          </View>
        </View>

        {/* Fee Breakdown */}
        <Text style={{ fontWeight: 'bold', marginBottom: 8, fontSize: 13 }}>
          FEE BREAKDOWN
        </Text>
        <View style={styles.feeTable}>
          <View style={styles.tableHeader}>
            <Text style={styles.col1}>S/N</Text>
            <Text style={styles.col2}>DESCRIPTION</Text>
            <Text style={styles.col3}>AMOUNT ({CEDI_SYMBOL})</Text>
          </View>
          {processedItems.map(item => (
            <View key={`${item.sn}-${item.description}`} style={styles.tableRow}>
              <Text style={styles.col1}>{item.sn}</Text>
              <Text style={styles.col2}>{item.description}</Text>
              <Text style={styles.col3}>{item.formattedAmount}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={{ width: '70%' }}>TOTAL:</Text>
            <Text style={{ width: '30%', textAlign: 'right' }}>{totalAmount}</Text>
          </View>
        </View>

        {/* Signature */}
        <View style={styles.signatureSection}>
          {signatureSrc ? (
            <Image
              style={{
                width: 150,
                height: 50,
                marginBottom: 10,
                alignSelf: 'flex-end' // Align image to the right
              }}
              src={signatureSrc}
            />
          ) : (
            <View style={styles.signatureLine} />
          )}
          <Text style={styles.signatureName}>
            {schoolInfo.headteacher || schoolInfo.headTeacherName || 'Headteacher Name'}
          </Text>
          <Text style={styles.signatureTitle}>Headteacher</Text>
        </View>
      </Page>
    </Document>
  );
});

export default FeeStatementPDF;