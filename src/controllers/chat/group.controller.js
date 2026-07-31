const admin = require("firebase-admin");
const db = admin.firestore();

const MAX_GROUP_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Create Group
 * POST /chat/group/create
 */
exports.createGroup = async (req, res) => {
  try {
    const ownerUid = req.user.uid;

    const {
      groupName,
      description = "",
      courseId = null,
      privacy = "private",
      photo = "",
    } = req.body;

    if (!groupName || !groupName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Group name is required.",
      });
    }

    if (groupName.trim().length > MAX_GROUP_NAME_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Group name must not exceed ${MAX_GROUP_NAME_LENGTH} characters.`,
      });
    }

    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Description must not exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
      });
    }

    if (!["public", "private"].includes(privacy)) {
      return res.status(400).json({
        success: false,
        message: "Privacy must be 'public' or 'private'.",
      });
    }

    const instituteSnapshot = await db
      .collection("institutes")
      .where("ownerUid", "==", ownerUid)
      .limit(1)
      .get();

    if (instituteSnapshot.empty) {
      return res.status(403).json({
        success: false,
        message: "Only institutes can create groups.",
      });
    }

    // Verify courseId exists if provided
    if (courseId) {
      const courseDoc = await db.collection("courses").doc(courseId).get();
      if (!courseDoc.exists) {
        return res.status(404).json({
          success: false,
          message: "Course not found.",
        });
      }
    }

    const groupRef = db.collection("groups").doc();

    const groupData = {
      groupId: groupRef.id,
      groupName: groupName.trim(),
      description: description.trim(),
      ownerUid,
      courseId,
      privacy,
      photo,
      memberCount: 1,
      type: courseId ? "course" : "general",
      unreadCount: {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true,
    };

    const batch = db.batch();

    batch.set(groupRef, groupData);

    // Write owner membership and also write a membership index document
    // so students can query their groups efficiently (no full-scan needed).
    batch.set(groupRef.collection("members").doc(ownerUid), {
      uid: ownerUid,
      role: "owner",
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(
      db.collection("groupMemberships").doc(`${ownerUid}_${groupRef.id}`),
      {
        uid: ownerUid,
        groupId: groupRef.id,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    );

    await batch.commit();

    return res.status(201).json({
      success: true,
      message: "Group created successfully.",
      data: groupData,
    });
  } catch (error) {
    console.error("Create Group Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get My Groups
 * GET /chat/group/list
 *
 * For institutes: returns groups they own.
 * For students: uses the groupMemberships index to avoid a full collection scan.
 */
exports.getMyGroups = async (req, res) => {
  try {
    const uid = req.user.uid;

    const instituteSnapshot = await db
      .collection("institutes")
      .where("ownerUid", "==", uid)
      .limit(1)
      .get();

    let groups = [];

    if (!instituteSnapshot.empty) {
      // Institute: query by ownerUid (indexed)
      const snapshot = await db
        .collection("groups")
        .where("ownerUid", "==", uid)
        .where("isActive", "==", true)
        .orderBy("updatedAt", "desc")
        .get();

      groups = snapshot.docs.map((doc) => doc.data());
    } else {
      // Student: use the groupMemberships index — avoids full groups scan
      const membershipsSnapshot = await db
        .collection("groupMemberships")
        .where("uid", "==", uid)
        .get();

      if (!membershipsSnapshot.empty) {
        const groupIds = membershipsSnapshot.docs.map((doc) => doc.data().groupId);

        // Firestore `in` supports up to 30 values per query; chunk if needed
        const CHUNK_SIZE = 30;
        for (let i = 0; i < groupIds.length; i += CHUNK_SIZE) {
          const chunk = groupIds.slice(i, i + CHUNK_SIZE);
          const groupsSnapshot = await db
            .collection("groups")
            .where("groupId", "in", chunk)
            .where("isActive", "==", true)
            .get();

          groupsSnapshot.docs.forEach((doc) => groups.push(doc.data()));
        }

        groups.sort((a, b) => {
          const aTime = a.updatedAt?.toMillis?.() || 0;
          const bTime = b.updatedAt?.toMillis?.() || 0;
          return bTime - aTime;
        });
      }
    }

    return res.status(200).json({
      success: true,
      total: groups.length,
      data: groups,
    });
  } catch (error) {
    console.error("Get My Groups Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Creates a group for a newly created course. Not an HTTP handler — called
 * internally by course.controller.js#createCourse right after the course
 * doc is written.
 */
exports.createGroupForCourse = async ({ courseId, courseTitle, ownerUid, photo = "" }) => {
  const groupRef = db.collection("groups").doc();

  const groupData = {
    groupId: groupRef.id,
    groupName: `${courseTitle} group`,
    description: `Discussion group for ${courseTitle}`,
    ownerUid,
    courseId,
    privacy: "private",
    photo,
    memberCount: 1,
    type: "course",
    unreadCount: {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    isActive: true,
  };

  const batch = db.batch();

  batch.set(groupRef, groupData);

  batch.set(groupRef.collection("members").doc(ownerUid), {
    uid: ownerUid,
    role: "owner",
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.set(
    db.collection("groupMemberships").doc(`${ownerUid}_${groupRef.id}`),
    {
      uid: ownerUid,
      groupId: groupRef.id,
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    }
  );

  await batch.commit();

  return groupData;
};

/**
 * Adds a student as a member of the group linked to a course.
 * Not an HTTP handler — called internally after enrollment succeeds.
 * Idempotent and silent on failure.
 */
exports.addStudentToCourseGroup = async (courseId, studentUid) => {
  if (!courseId || !studentUid) return;

  try {
    const groupSnapshot = await db
      .collection("groups")
      .where("courseId", "==", courseId)
      .limit(1)
      .get();

    if (groupSnapshot.empty) return;

    const groupRef = groupSnapshot.docs[0].ref;
    const groupId = groupSnapshot.docs[0].id;

    await db.runTransaction(async (transaction) => {
      const memberRef = groupRef.collection("members").doc(studentUid);
      const memberDoc = await transaction.get(memberRef);

      if (memberDoc.exists) return;

      transaction.set(memberRef, {
        uid: studentUid,
        role: "member",
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(groupRef, {
        memberCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Write membership index so the student's group list is queryable
      const membershipRef = db
        .collection("groupMemberships")
        .doc(`${studentUid}_${groupId}`);

      transaction.set(membershipRef, {
        uid: studentUid,
        groupId,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    console.error("addStudentToCourseGroup error:", error);
  }
};

/**
 * Get Global (Discoverable) Groups
 * GET /chat/group/global
 *
 * Public, active groups the current user is not already a member of.
 */
exports.getGlobalGroups = async (req, res) => {
  try {
    const uid = req.user.uid;

    // Fetch the user's group memberships from the index — no full scan needed
    const membershipsSnapshot = await db
      .collection("groupMemberships")
      .where("uid", "==", uid)
      .get();

    const memberGroupIds = new Set(
      membershipsSnapshot.docs.map((doc) => doc.data().groupId)
    );

    const snapshot = await db
      .collection("groups")
      .where("privacy", "==", "public")
      .where("isActive", "==", true)
      .orderBy("updatedAt", "desc")
      .get();

    const groups = snapshot.docs
      .filter((doc) => !memberGroupIds.has(doc.id))
      .map((doc) => doc.data());

    return res.status(200).json({
      success: true,
      total: groups.length,
      data: groups,
    });
  } catch (error) {
    console.error("Get Global Groups Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Group By Id
 * GET /chat/group/:groupId
 */
exports.getGroupById = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: "Group ID is required.",
      });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const [groupDoc, memberDoc] = await Promise.all([
      groupRef.get(),
      groupRef.collection("members").doc(uid).get(),
    ]);

    if (!groupDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    if (!memberDoc.exists) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this group.",
      });
    }

    return res.status(200).json({
      success: true,
      data: groupDoc.data(),
    });
  } catch (error) {
    console.error("Get Group By Id Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
