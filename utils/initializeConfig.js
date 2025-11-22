// utils/initializeConfig.js
const FeedingFeeConfig = require('../models/FeedingFeeConfig');

const initializeDefaultConfig = async (schoolId) => {
  try {
    const config = await FeedingFeeConfig.findOneAndUpdate(
      { school: schoolId },
      { 
        feeBands: {
          crecheToKG2: 500,
          basic1To6: 400,
          basic7To9: 300
        },
        currency: 'GHS'
      },
      { upsert: true, new: true }
    );
    return config;
  } catch (error) {
    console.error('Initialization failed:', error);
    throw error;
  }
};

module.exports = { initializeDefaultConfig };