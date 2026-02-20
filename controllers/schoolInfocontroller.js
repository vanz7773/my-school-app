const SchoolInfo = require('../models/SchoolInfo');
const { uploadFile } = require('../utils/firebaseStorage'); // New Firebase helper
const School = require('../models/School');
// GET school info
exports.getSchoolInfo = async (req, res) => {
  try {
    const schoolId = req.user.school;
    if (!schoolId) return res.status(400).json({ message: 'No school found for this user' });


    const schoolInfo = await SchoolInfo.findOne({ school: schoolId })
      .populate('school', 'name location') // ✅ include location here
      .lean();

    if (!schoolInfo) return res.status(404).json({ message: 'School info not found' });

    res.json({
      ...schoolInfo,
      schoolName: schoolInfo.school?.name || 'School Name',
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// SAVE / UPDATE school info
exports.saveSchoolInfo = async (req, res) => {
  console.log("---- saveSchoolInfo called ----");
  console.log("req.user:", req.user);

  try {
    const schoolId = req.user?.school;
    if (!schoolId) {
      console.warn("No schoolId found on req.user");
      return res.status(400).json({ message: "No school found for this user" });
    }
    console.log("schoolId:", schoolId);

    // Debug incoming payload
    console.log("Incoming req.body:", req.body);
    console.log("Incoming req.files keys:", Object.keys(req.files || {}));
    if (req.files?.logo) console.log("logo file present:", req.files.logo[0]?.originalname);
    if (req.files?.signature) console.log("signature file present:", req.files.signature[0]?.originalname);

    // Load existing record (if any)
    let schoolInfo = await SchoolInfo.findOne({ school: schoolId }).lean();
    console.log("Existing schoolInfo (from DB):", schoolInfo);

    // Initialize URLs from existing DB record
    let logoUrl = schoolInfo?.logo || null;
    let signatureUrl = schoolInfo?.headTeacherSignature || null;
    const warnings = [];

    // Upload logo if provided
    if (req.files?.logo?.length > 0) {
      try {
        console.log("Uploading logo to Firebase...");
        const uploadedLogoUrl = await uploadFile(req.files.logo[0], "logo", schoolId);
        console.log("Uploaded logo URL:", uploadedLogoUrl);
        if (uploadedLogoUrl) logoUrl = uploadedLogoUrl;
        else {
          warnings.push("Logo upload returned no URL; keeping existing logo.");
          console.warn(warnings[warnings.length - 1]);
        }
      } catch (err) {
        console.error("Logo upload failed:", err);
        warnings.push("Logo upload failed; keeping existing logo.");
      }
    } else {
      console.log("No new logo uploaded; preserving existing logo.");
    }

    // Upload signature if provided
    if (req.files?.signature?.length > 0) {
      try {
        console.log("Uploading signature to Firebase...");
        const uploadedSignatureUrl = await uploadFile(req.files.signature[0], "signature", schoolId);
        console.log("Uploaded signature URL:", uploadedSignatureUrl);
        if (uploadedSignatureUrl) signatureUrl = uploadedSignatureUrl;
        else {
          warnings.push("Signature upload returned no URL; keeping existing signature.");
          console.warn(warnings[warnings.length - 1]);
        }
      } catch (err) {
        console.error("Signature upload failed:", err);
        warnings.push("Signature upload failed; keeping existing signature.");
      }
    } else {
      console.log("No new signature uploaded; preserving existing signature.");
    }

    // Prepare updateData with preservation of existing fields
    const textFields = ["address", "phone", "email", "motto", "headTeacherName"];
    const updateData = {
      school: schoolId,
      logo: logoUrl,
      headTeacherSignature: signatureUrl,
    };

    textFields.forEach((field) => {
      const incoming = typeof req.body[field] === "string" ? req.body[field].trim() : undefined;
      if (incoming !== undefined && incoming !== "") {
        updateData[field] = incoming;
        console.log(`Using incoming field ${field}:`, incoming);
      } else if (schoolInfo && (schoolInfo[field] || schoolInfo[field] === "")) {
        updateData[field] = schoolInfo[field];
        console.log(`Preserving existing field ${field}:`, schoolInfo[field]);
      } else {
        updateData[field] = "";
        console.log(`No value for ${field}; setting to empty string`);
      }
    });

    console.log("Final updateData to save:", updateData);

    // Persist to DB (upsert)
    const updatedInfo = await SchoolInfo.findOneAndUpdate(
      { school: schoolId },
      updateData,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
      .populate("school", "name")
      .lean();

    console.log("Saved updatedInfo:", updatedInfo);

    // Return updated object with optional warnings
    res.json({
      ...updatedInfo,
      schoolName: updatedInfo.school?.name || "School Name",
      warnings: warnings.length ? warnings : undefined,
    });

  } catch (error) {
    console.error("Error in saveSchoolInfo:", error);
    res.status(500).json({ message: "Error saving school info", error: error.message });
  }
};


// GET upload URL for direct frontend upload
exports.getUploadSignature = async (req, res) => {
  try {
    const { fileName, contentType } = req.query; // frontend provides filename + type
    if (!fileName || !contentType) {
      return res.status(400).json({ message: 'fileName and contentType are required' });
    }

    const file = bucket.file(`school_uploads/${Date.now()}_${fileName}`);

    // Generate signed URL valid for 15 minutes
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType,
    });

    res.json({ uploadUrl: url, publicPath: file.name });
  } catch (err) {
    res.status(500).json({ message: 'Error generating upload URL', error: err.message });
  }
};

exports.updateSchoolLocation = async (req, res) => {
  const { id } = req.params;
  const { coordinates } = req.body; // Expect [[[lng, lat], ...]]

  console.log(`📥 Updating location for school ${id}:`, coordinates);

  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    console.warn('⚠️ Invalid coordinates format:', coordinates);
    return res.status(400).json({ message: 'Invalid coordinates format' });
  }

  try {
    const school = await School.findByIdAndUpdate(
      id,
      { location: { type: 'Polygon', coordinates } },
      { new: true }
    );

    if (!school) {
      console.warn(`⚠️ School not found: ${id}`);
      return res.status(404).json({ message: 'School not found' });
    }

    console.log('✅ School location updated:', school._id);
    res.status(200).json({ message: 'School location updated', data: school });
  } catch (err) {
    console.error('❌ Error updating school location:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
// Proxy image to bypass CORS
exports.proxyImage = async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    // Use native fetch (Node 18+)
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    // Convert Web Stream / ArrayBuffer to Node Buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.send(buffer);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send('Error fetching image');
  }
};

// Restore missing getFileById
exports.getFileById = async (req, res) => {
  try {
    const { id } = req.params;
    // logic to fetch file info from DB or storage
    res.json({ message: `File ${id} would be returned here.` });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
