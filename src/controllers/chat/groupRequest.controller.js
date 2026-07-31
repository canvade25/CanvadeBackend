const admin = require("firebase-admin");
const db = admin.firestore();

// Sentinel objects used to signal specific error conditions out of a
// Firestore transaction without relying on string matching.
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Send Group Join Request
 * POST /chat/group/request/send
 */
exports.sendGroupJoinRequest = async (req, res) => {
  try {
    const studentUid = req.user.uid;
    const { groupId } = req.body;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: "Group ID is required.",
      });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    const group = groupDoc.data();

    if (!group.isActive) {
      return res.status(400).json({
        success: false,
        message: "Group is inactive.",
      });
    }

    // Private groups do not accept join requests
    if (group.privacy === "private") {
      return res.status(403).json({
        success: false,
        message: "This group is private. Join requests are not allowed.",
      });
    }

    const [memberDoc, pendingSnapshot] = await Promise.all([
      groupRef.collection("members").doc(studentUid).get(),
      db
        .collection("groupRequests")
        .where("groupId", "==", groupId)
        .where("studentUid", "==", studentUid)
        .where("status", "==", "pending")
        .limit(1)
        .get(),
    ]);

    if (memberDoc.exists) {
      return res.status(409).json({
        success: false,
        message: "You are already a member.",
      });
    }

    if (!pendingSnapshot.empty) {
      return res.status(409).json({
        success: false,
        message: "Join request already sent.",
      });
    }

    const requestRef = db.collection("groupRequests").doc();
    const request = {
      requestId: requestRef.id,
      groupId,
      ownerUid: group.ownerUid,
      studentUid,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await requestRef.set(request);

    return res.status(201).json({
      success: true,
      message: "Join request sent successfully.",
      data: request,
    });
  } catch (error) {
    console.error("Send Group Join Request Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Received Group Join Requests
 * GET /chat/group/request/received
 */
exports.getReceivedGroupRequests = async (req, res) => {
  try {
    const ownerUid = req.user.uid;

    const instituteSnapshot = await db
      .collection("institutes")
      .where("ownerUid", "==", ownerUid)
      .limit(1)
      .get();

    if (instituteSnapshot.empty) {
      return res.status(403).json({
        success: false,
        message: "Only institutes can view group requests.",
      });
    }

    const snapshot = await db
      .collection("groupRequests")
      .where("ownerUid", "==", ownerUid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No pending requests found.",
        total: 0,
        data: [],
      });
    }

    // Fetch student and group details in parallel for all requests
    const requests = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const request = doc.data();

        const [studentDoc, groupDoc] = await Promise.all([
          db.collection("users").doc(request.studentUid).get(),
          db.collection("groups").doc(request.groupId).get(),
        ]);

        return {
          requestId: request.requestId,
          status: request.status,
          createdAt: request.createdAt,

          student: studentDoc.exists
            ? {
                uid: studentDoc.id,
                name: studentDoc.data().name || studentDoc.data().displayName || "",
                email: studentDoc.data().email || "",
                profileImage: studentDoc.data().profileImage || null,
                studentId: studentDoc.data().studentId || null,
              }
            : null,

          group: groupDoc.exists
            ? {
                groupId: groupDoc.id,
                groupName: groupDoc.data().groupName,
                description: groupDoc.data().description,
                photo: groupDoc.data().photo,
                memberCount: groupDoc.data().memberCount,
              }
            : null,
        };
      })
    );

    return res.status(200).json({
      success: true,
      message: "Group requests fetched successfully.",
      total: requests.length,
      data: requests,
    });
  } catch (error) {
    console.error("Get Group Requests Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Sent Group Join Requests
 * GET /chat/group/request/sent
 */
exports.getSentGroupRequests = async (req, res) => {
  try {
    const studentUid = req.user.uid;

    const snapshot = await db
      .collection("groupRequests")
      .where("studentUid", "==", studentUid)
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No group requests found.",
        total: 0,
        data: [],
      });
    }

    // Fetch group and owner details in parallel for all requests
    const requests = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const request = doc.data();

        const [groupDoc, ownerDoc] = await Promise.all([
          db.collection("groups").doc(request.groupId).get(),
          db.collection("users").doc(request.ownerUid).get(),
        ]);

        return {
          requestId: request.requestId,
          groupId: request.groupId,
          status: request.status,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,

          group: groupDoc.exists
            ? {
                groupId: groupDoc.id,
                groupName: groupDoc.data().groupName,
                description: groupDoc.data().description,
                photo: groupDoc.data().photo,
                privacy: groupDoc.data().privacy,
                memberCount: groupDoc.data().memberCount,
              }
            : null,

          owner: ownerDoc.exists
            ? {
                uid: ownerDoc.id,
                name: ownerDoc.data().name || ownerDoc.data().displayName || "",
                email: ownerDoc.data().email || "",
                profileImage: ownerDoc.data().profileImage || null,
              }
            : null,
        };
      })
    );

    return res.status(200).json({
      success: true,
      message: "Group requests fetched successfully.",
      total: requests.length,
      data: requests,
    });
  } catch (error) {
    console.error("Get Sent Group Requests Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Accept Group Join Request
 * PATCH /chat/group/request/accept/:requestId
 */
exports.acceptGroupRequest = async (req, res) => {
  try {
    const ownerUid = req.user.uid;
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required.",
      });
    }

    await db.runTransaction(async (transaction) => {
      const requestRef = db.collection("groupRequests").doc(requestId);
      const requestDoc = await transaction.get(requestRef);

      if (!requestDoc.exists) {
        throw new HttpError(404, "Request not found.");
      }

      const request = requestDoc.data();

      if (request.ownerUid !== ownerUid) {
        throw new HttpError(403, "Unauthorized.");
      }

      if (request.status !== "pending") {
        throw new HttpError(400, `Request already ${request.status}.`);
      }

      const groupRef = db.collection("groups").doc(request.groupId);
      const groupDoc = await transaction.get(groupRef);

      if (!groupDoc.exists) {
        throw new HttpError(404, "Group not found.");
      }

      const group = groupDoc.data();

      if (!group.isActive) {
        throw new HttpError(400, "Group is inactive.");
      }

      const memberRef = groupRef.collection("members").doc(request.studentUid);
      const memberDoc = await transaction.get(memberRef);

      if (memberDoc.exists) {
        throw new HttpError(409, "Student is already a member.");
      }

      transaction.set(memberRef, {
        uid: request.studentUid,
        role: "member",
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(groupRef, {
        memberCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.update(requestRef, {
        status: "accepted",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const notificationRef = db.collection("notifications").doc();
      transaction.set(notificationRef, {
        notificationId: notificationRef.id,
        receiverUid: request.studentUid,
        title: "Group Join Request Accepted",
        body: `Your request to join "${group.groupName}" has been accepted.`,
        type: "group_request",
        referenceId: group.groupId,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const systemMessageRef = groupRef.collection("messages").doc();
      transaction.set(systemMessageRef, {
        messageId: systemMessageRef.id,
        type: "system",
        text: "A new member joined the group.",
        senderId: ownerUid,
        targetUid: request.studentUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.status(200).json({
      success: true,
      message: "Group request accepted successfully.",
    });
  } catch (error) {
    console.error("Accept Group Request Error:", error);

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Reject Group Join Request
 * PATCH /chat/group/request/reject/:requestId
 */
exports.rejectGroupRequest = async (req, res) => {
  try {
    const ownerUid = req.user.uid;
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required.",
      });
    }

    await db.runTransaction(async (transaction) => {
      const requestRef = db.collection("groupRequests").doc(requestId);
      const requestDoc = await transaction.get(requestRef);

      if (!requestDoc.exists) {
        throw new HttpError(404, "Group request not found.");
      }

      const request = requestDoc.data();

      if (request.ownerUid !== ownerUid) {
        throw new HttpError(403, "You are not authorized to reject this request.");
      }

      if (request.status !== "pending") {
        throw new HttpError(400, `Request already ${request.status}.`);
      }

      transaction.update(requestRef, {
        status: "rejected",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const notificationRef = db.collection("notifications").doc();
      transaction.set(notificationRef, {
        notificationId: notificationRef.id,
        receiverUid: request.studentUid,
        title: "Group Join Request Rejected",
        body: "Your request to join the group has been rejected.",
        type: "group_request",
        referenceId: request.groupId,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.status(200).json({
      success: true,
      message: "Group request rejected successfully.",
    });
  } catch (error) {
    console.error("Reject Group Request Error:", error);

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Cancel Group Join Request
 * DELETE /chat/group/request/cancel/:requestId
 */
exports.cancelGroupRequest = async (req, res) => {
  try {
    const studentUid = req.user.uid;
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required.",
      });
    }

    const requestRef = db.collection("groupRequests").doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group request not found.",
      });
    }

    const request = requestDoc.data();

    if (request.studentUid !== studentUid) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to cancel this request.",
      });
    }

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${request.status} request.`,
      });
    }

    await requestRef.delete();

    return res.status(200).json({
      success: true,
      message: "Group join request cancelled successfully.",
    });
  } catch (error) {
    console.error("Cancel Group Request Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
