const admin = require("firebase-admin");
const db = admin.firestore();

/**
 * Block User
 * POST /chat/block/:uid
 *
 * Prevents the target user from sending further messages to the caller.
 * Chat history and the conversation itself are left untouched.
 */
exports.blockUser = async (req, res) => {
  try {
    const uid = req.user.uid;
    const targetUid = req.params.uid;

    if (!targetUid) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    if (targetUid === uid) {
      return res.status(400).json({
        success: false,
        message: "You cannot block yourself.",
      });
    }

    // Verify the target user exists before writing
    const targetDoc = await db.collection("users").doc(targetUid).get();

    if (!targetDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    await db
      .collection("users")
      .doc(uid)
      .set(
        { blockedUsers: admin.firestore.FieldValue.arrayUnion(targetUid) },
        { merge: true }
      );

    return res.status(200).json({
      success: true,
      message: "User blocked.",
    });
  } catch (error) {
    console.error("Block User Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Unblock User
 * DELETE /chat/block/:uid
 */
exports.unblockUser = async (req, res) => {
  try {
    const uid = req.user.uid;
    const targetUid = req.params.uid;

    if (!targetUid) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    if (targetUid === uid) {
      return res.status(400).json({
        success: false,
        message: "You cannot unblock yourself.",
      });
    }

    await db
      .collection("users")
      .doc(uid)
      .set(
        { blockedUsers: admin.firestore.FieldValue.arrayRemove(targetUid) },
        { merge: true }
      );

    return res.status(200).json({
      success: true,
      message: "User unblocked.",
    });
  } catch (error) {
    console.error("Unblock User Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Blocked Users
 * GET /chat/block
 */
exports.getBlockedUsers = async (req, res) => {
  try {
    const uid = req.user.uid;

    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const blockedUids = userDoc.data().blockedUsers || [];

    if (blockedUids.length === 0) {
      return res.status(200).json({
        success: true,
        total: 0,
        data: [],
      });
    }

    // Fetch blocked user profiles in parallel
    const blockedUsers = await Promise.all(
      blockedUids.map(async (blockedUid) => {
        const doc = await db.collection("users").doc(blockedUid).get();
        if (!doc.exists) return null;

        const user = doc.data();
        return {
          uid: blockedUid,
          name: user.name || user.displayName || "",
          email: user.email || "",
          profileImage: user.profileImage || null,
        };
      })
    );

    return res.status(200).json({
      success: true,
      total: blockedUsers.filter(Boolean).length,
      data: blockedUsers.filter(Boolean),
    });
  } catch (error) {
    console.error("Get Blocked Users Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
