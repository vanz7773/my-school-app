// controllers/subjectController.js
const Subject = require("../models/Subject");
const Teacher = require("../models/Teacher");

// 🧠 Default subject list (global)
const defaultSubjects = [
  { name: "English Language", shortName: "ENG LANG", aliases: ["ENG", "ENGLISH"] },
  { name: "Career Technology", shortName: "CAREER TECH", aliases: ["C. TECH", "CAREER TECH"] },
  { name: "Social Studies", shortName: "SOC STUD", aliases: ["SOCIAL", "SOC STUD"] },
  { name: "Mathematics", shortName: "MATH", aliases: ["MATHS"] },
  { name: "Science", shortName: "SCI", aliases: ["GEN SCI", "BASIC SCIENCE"] },
  { name: "History", shortName: "HIST", aliases: ["HISTORRY"] },
  { name: "French", shortName: "FREN", aliases: [] },
  { name: "Computing", shortName: "COMP", aliases: ["ICT", "COMPUTER"] },
  { name: "Religious and Moral Education", shortName: "RME", aliases: ["R.M.E", "RELIGION"] },
  { name: "Ghanaian Language", shortName: "GH LANG", aliases: ["GHANAIAN LANG", "GHLANG"] },
  { name: "Creative Arts & Design", shortName: "C. ARTS", aliases: ["CREATIVE ARTS", "CAD"] },
  { name: "Literacy", shortName: "LIT", aliases: [] },
  { name: "Numeracy", shortName: "NUM", aliases: [] },
  { name: "Nature and Environment", shortName: "N&E", aliases: ["NATURE", "ENVIRONMENT"] },
  { name: "Social Skills", shortName: "SOC SKILLS", aliases: ["SOCIAL SKILLS"] },
  { name: "Writing", shortName: "WRITING", aliases: [] },
  { name: "OWOP", shortName: "OWOP", aliases: ["OUR WORLD OUR PEOPLE", "OUR WORLD AND OUR PEOPLE"] },
];

// helper to escape regex special chars
function escapeRegex(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDefaultSubject(subject) {
  return {
    name: subject.name.trim().toUpperCase(),
    shortName: subject.shortName.trim().toUpperCase(),
    aliases: subject.aliases.map((a) => a.trim().toUpperCase()),
  };
}

async function ensureDefaultSubjects() {
  let created = 0;
  let updated = 0;

  for (const subject of defaultSubjects.map(formatDefaultSubject)) {
    const nameRegex = new RegExp(`^${escapeRegex(subject.name)}$`, "i");
    const shortNameRegex = new RegExp(`^${escapeRegex(subject.shortName)}$`, "i");
    const aliasRegexes = subject.aliases.map((alias) => new RegExp(`^${escapeRegex(alias)}$`, "i"));

    let existing = await Subject.findOne({
      $or: [
        { name: nameRegex },
        { shortName: shortNameRegex },
        ...aliasRegexes.map((aliasRegex) => ({ aliases: { $elemMatch: aliasRegex } })),
      ],
    });

    if (!existing) {
      await Subject.create(subject);
      created += 1;
      continue;
    }

    let changed = false;
    if (!existing.shortName) {
      existing.shortName = subject.shortName;
      changed = true;
    }

    const existingAliases = (existing.aliases || []).map((alias) => alias.trim().toUpperCase());
    const mergedAliases = Array.from(new Set([...existingAliases, ...subject.aliases]));
    if (mergedAliases.length !== existingAliases.length) {
      existing.aliases = mergedAliases;
      changed = true;
    }

    if (changed) {
      await existing.save();
      updated += 1;
    }
  }

  return { created, updated };
}

/**
 * GET /subjects/global/list
 * Return the structured defaultSubjects array (formatted)
 */
exports.getGlobalSubjects = async (req, res) => {
  try {
    const formatted = defaultSubjects.map(formatDefaultSubject);
    return res.status(200).json(formatted);
  } catch (err) {
    console.error("❌ Error fetching global subjects:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /subjects
 * Create or update a global subject. Any `school` value in the body is ignored.
 */
exports.createSubject = async (req, res) => {
  try {
    const { name, shortName, aliases } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Name is required." });
    }

    const normalizedName = name.trim().toUpperCase();
    const normalizedShort = (shortName || normalizedName).trim().toUpperCase();
    const normalizedAliases = (aliases || []).map((a) => a.trim().toUpperCase());

    // search globally (case-insensitive)
    const regexName = new RegExp(`^${escapeRegex(normalizedName)}$`, "i");

    let subject = await Subject.findOne({
      $or: [
        { name: regexName },
        { shortName: new RegExp(`^${escapeRegex(normalizedShort)}$`, "i") },
        { aliases: { $elemMatch: new RegExp(`^${escapeRegex(normalizedName)}$`, "i") } },
      ],
    });

    if (!subject) {
      subject = await Subject.create({
        // store canonical uppercase values for consistency
        name: normalizedName,
        shortName: normalizedShort,
        aliases: normalizedAliases,
      });
      console.log(`🌱 Created GLOBAL subject: ${normalizedName}`);
    } else {
      // update shortName/aliases if needed
      let changed = false;
      if (normalizedShort && subject.shortName !== normalizedShort) {
        subject.shortName = normalizedShort;
        changed = true;
      }
      if (normalizedAliases.length > 0) {
        const existing = (subject.aliases || []).map((a) => a.trim().toUpperCase());
        const merged = Array.from(new Set([...existing, ...normalizedAliases]));
        if (merged.length !== existing.length) {
          subject.aliases = merged;
          changed = true;
        }
      }
      if (changed) {
        await subject.save();
        console.log(`🔁 Updated GLOBAL subject meta: ${normalizedName}`);
      }
    }

    return res.status(201).json(subject);
  } catch (err) {
    console.error("❌ Error creating/updating subject:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /subjects
 * Return all global subjects (deduped). If collection empty, insert global defaults once.
 */
exports.getSubjects = async (req, res) => {
  try {
    const { created, updated } = await ensureDefaultSubjects();
    if (created || updated) {
      console.log(`✅ Global default subjects synced. Created: ${created}, updated: ${updated}.`);
    }

    const subjects = await Subject.find({}).sort("name");
    return res.json(subjects);
  } catch (err) {
    console.error("❌ Error fetching subjects:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PUT /subjects/normalize
 * Normalize teacher.subject (string) -> subject ObjectId across system.
 * Finds/creates only global subjects.
 */
exports.normalizeTeacherSubjects = async (req, res) => {
  try {
    // optionally accept a subset of teachers via body.criteria (but by default run on all teachers)
    const filter = {}; // process all teachers
    const teachers = await Teacher.find(filter);

    for (const teacher of teachers) {
      if (!teacher.subject) continue;

      const subjectName = (teacher.subject + "").trim();
      if (!subjectName) continue;
      const cleaned = subjectName.toUpperCase();

      // Find a matching global subject by name, shortName, or alias (case-insensitive)
      const nameRegex = new RegExp(`^${escapeRegex(cleaned)}$`, "i");
      const subject = await Subject.findOne({
        $or: [
          { name: nameRegex },
          { shortName: nameRegex },
          { aliases: { $elemMatch: nameRegex } },
        ],
      });

      let finalSubject = subject;
      if (!finalSubject) {
        // create global subject so all schools can use it
        finalSubject = await Subject.create({
          name: cleaned,
          shortName: cleaned,
          aliases: [],
        });
        console.log(`🆕 Auto-created GLOBAL subject from teacher: ${cleaned}`);
      }

      teacher.subject = finalSubject._id;
      await teacher.save();
    }

    return res.json({ message: "✅ Teacher subjects normalized to GLOBAL subjects" });
  } catch (err) {
    console.error("❌ Error normalizing teacher subjects:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /subjects/sync
 * Ensure global default subjects exist (idempotent).
 */
exports.syncDefaultSubjectsForAllSchools = async (req, res) => {
  try {
    const { created, updated } = await ensureDefaultSubjects();
    return res.json({
      message: "✅ Global default subjects synced",
      totalCreated: created,
      totalUpdated: updated,
    });
  } catch (err) {
    console.error("❌ Error ensuring global default subjects:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
