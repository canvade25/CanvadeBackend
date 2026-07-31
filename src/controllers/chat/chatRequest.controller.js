const admin = require("firebase-admin");
const db = admin.firestore();
const { buildMemberDetail } = require("../../utils/chatParticipant");

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Send Chat Request
 * POST /chat/request/send
 */
exports.sendChatRequest = async (req, res) => {
  try {
    const senderUid = req.user.uid;
    const { receiverUid: rawReceiverId } = req.body;

    if (!rawReceiverId || typeof rawReceiverId !== "string") {
      return res.status(400).json({
        success: false,
        message: "Receiver UID is required.",
      });
    }

    // Accept either the receiver's Firebase uid or their studentId
    let receiverDoc = await db.collection("users").doc(rawReceiverId).get();

    if (!receiverDoc.exists) {
      const studentIdMatch = await db
        .collection("users")
        .where("studentId", "==", rawReceiverId)
        .limit(1)
        .get();

      if (!studentIdMatch.empty) {
        receiverDoc = studentIdMatch.docs[0];
      }
    }

    if (!receiverDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Receiver not found.",
      });
    }

    const receiverUid = receiverDoc.id;

    if (senderUid === receiverUid) {
      return res.status(400).json({
        success: false,
        message: "You cannot send a chat request to yourself.",
      });
    }

    const receiver = receiverDoc.data();

    if (receiver.role !== "student") {
      return res.status(403).json({
        success: false,
        message: "Chat requests can only be sent to students.",
      });
    }

    // Run duplicate checks in parallel
    const [pendingRequest, reverseRequest, conversationSnapshot] =
      await Promise.all([
        db
          .collection("chatRequests")
          .where("senderUid", "==", senderUid)
          .where("receiverUid", "==", receiverUid)
          .where("status", "==", "pending")
          .limit(1)
          .get(),
        db
          .collection("chatRequests")
          .where("senderUid", "==", receiverUid)
          .where("receiverUid", "==", senderUid)
          .where("status", "==", "pending")
          .limit(1)
          .get(),
        db
          .collection("conversations")
          .where("type", "==", "individual")
          .where("members", "array-contains", senderUid)
          .get(),
      ]);

    if (!pendingRequest.empty) {
      return res.status(409).json({
        success: false,
        message: "Chat request already sent.",
      });
    }

    if (!reverseRequest.empty) {
      return res.status(409).json({
        success: false,
        message:
          "This student has already sent you a chat request. Please accept it instead.",
      });
    }

    const conversationExists = conversationSnapshot.docs.some((doc) =>
      (doc.data().members || []).includes(receiverUid)
    );

    if (conversationExists) {
      return res.status(409).json({
        success: false,
        message: "Conversation already exists.",
      });
    }

    const requestRef = db.collection("chatRequests").doc();

    const requestData = {
      requestId: requestRef.id,
      senderUid,
      receiverUid,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await requestRef.set(requestData);

    return res.status(201).json({
      success: true,
      message: "Chat request sent successfully.",
      data: requestData,
    });
  } catch (error) {
    console.error("Send Chat Request Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Received Chat Requests
 * GET /chat/request/received
 */
exports.getReceivedChatRequests = async (req, res) => {
  try {
    const uid = req.user.uid;

    const snapshot = await db
      .collection("chatRequests")
      .where("receiverUid", "==", uid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No pending chat requests found.",
        data: [],
      });
    }

    const requests = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const request = doc.data();
        const senderDoc = await db
          .collection("users")
          .doc(request.senderUid)
          .get();

        if (!senderDoc.exists) return null;

        const sender = senderDoc.data();

        return {
          requestId: request.requestId,
          senderUid: request.senderUid,
          status: request.status,
          createdAt: request.createdAt,
          sender: {
            uid: request.senderUid,
            name: sender.name || sender.displayName || "",
            email: sender.email || "",
            profileImage: sender.profileImage || null,
            studentId: sender.studentId || null,
          },
        };
      })
    );

    const filtered = requests.filter(Boolean);

    return res.status(200).json({
      success: true,
      message: "Received chat requests fetched successfully.",
      total: filtered.length,
      data: filtered,
    });
  } catch (error) {
    console.error("Get Received Chat Requests Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Sent Chat Requests
 * GET /chat/request/sent
 */
exports.getSentChatRequests = async (req, res) => {
  try {
    const uid = req.user.uid;

    const snapshot = await db
      .collection("chatRequests")
      .where("senderUid", "==", uid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No sent chat requests found.",
        data: [],
      });
    }

    const requests = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const request = doc.data();
        const receiverDoc = await db
          .collection("users")
          .doc(request.receiverUid)
          .get();

        if (!receiverDoc.exists) return null;

        const receiver = receiverDoc.data();

        return {
          requestId: request.requestId,
          receiverUid: request.receiverUid,
          status: request.status,
          createdAt: request.createdAt,
          receiver: {
            uid: request.receiverUid,
            name: receiver.name || receiver.displayName || "",
            email: receiver.email || "",
            profileImage: receiver.profileImage || null,
            studentId: receiver.studentId || null,
          },
        };
      })
    );

    const filtered = requests.filter(Boolean);

    return res.status(200).json({
      success: true,
      message: "Sent chat requests fetched successfully.",
      total: filtered.length,
      data: filtered,
    });
  } catch (error) {
    console.error("Get Sent Chat Requests Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Accept Chat Request
 * PATCH /chat/request/accept/:requestId
 */
exports.acceptChatRequest = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required.",
      });
    }

    const requestRef = db.collection("chatRequests").doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Chat request not found.",
      });
    }

    const request = requestDoc.data();

    if (request.receiverUid !== uid) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to accept this request.",
      });
    }

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Request already ${request.status}.`,
      });
    }

    const members = [request.senderUid, request.receiverUid].sort();
    const participantKey = members.join("_");

    // Build member details before entering the transaction so that Firestore
    // reads inside the transaction remain document-based (no collection queries).
    const [senderDetail, receiverDetail] = await Promise.all([
      buildMemberDetail(db, request.senderUid),
      buildMemberDetail(db, request.receiverUid),
    ]);

    const result = await db.runTransaction(async (transaction) => {
      // Re-read the request inside the transaction to guard against concurrent
      // double-accepts.
      const freshRequest = await transaction.get(requestRef);

      if (freshRequest.data().status !== "pending") {
        throw new HttpError(400, `Request already ${freshRequest.data().status}.`);
      }

      // Check if a conversation with this participantKey already exists.
      // We read the conversation doc by a deterministic ID to keep this
      // inside the transaction with a document read (not a query).
      const conversationRef = db.collection("conversations").doc(participantKey);
      const existingConversation = await transaction.get(conversationRef);

      if (existingConversation.exists) {
        throw new HttpError(409, "Conversation already exists.");
      }

      const conversationData = {
        conversationId: participantKey,
        type: "individual",
        participantKey,
        members,
        memberDetails: {
          [request.senderUid]: senderDetail,
          [request.receiverUid]: receiverDetail,
        },
        lastMessage: "",
        lastMessageType: null,
        lastMessageSender: null,
        lastMessageTime: null,
        unreadCount: {
          [request.senderUid]: 0,
          [request.receiverUid]: 0,
        },
        deletedFor: [],
        isActive: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      transaction.set(conversationRef, conversationData);

      transaction.update(requestRef, {
        status: "accepted",
        conversationId: participantKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return conversationData;
    });

    return res.status(200).json({
      success: true,
      message: "Chat request accepted successfully.",
      data: result,
    });
  } catch (error) {
    console.error("Accept Chat Request Error:", error);

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
 * Reject Chat Request
 * PATCH /chat/request/reject/:requestId
 */
exports.rejectChatRequest = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required.",
      });
    }

    const requestRef = db.collection("chatRequests").doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Chat request not found.",
      });
    }

    const request = requestDoc.data();

    if (request.receiverUid !== uid) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to reject this request.",
      });
    }

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Request already ${request.status}.`,
      });
    }

    await requestRef.update({
      status: "rejected",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      message: "Chat request rejected successfully.",
    });
  } catch (error) {
    console.error("Reject Chat Request Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Cancel Chat Request
 * DELETE /chat/request/cancel/:requestId
 */
exports.cancelChatRequest = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required.",
      });
    }

    const requestRef = db.collection("chatRequests").doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Chat request not found.",
      });
    }

    const request = requestDoc.data();

    if (request.senderUid !== uid) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to cancel this request.",
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
      message: "Chat request cancelled successfully.",
    });
  } catch (error) {
    console.error("Cancel Chat Request Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
