const admin = require("firebase-admin");
const db = admin.firestore();
const { buildMemberDetail } = require("../../utils/chatParticipant");

const MESSAGES_PAGE_SIZE = 50;

/**
 * Get My Conversations
 * GET /chat/conversations
 */
exports.getMyConversations = async (req, res) => {
  try {
    const uid = req.user.uid;

    const snapshot = await db
      .collection("conversations")
      .where("members", "array-contains", uid)
      .where("isActive", "==", true)
      .orderBy("updatedAt", "desc")
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No conversations found.",
        data: [],
      });
    }

    const conversations = await Promise.all(
      snapshot.docs
        .filter((doc) => !(doc.data().deletedFor || []).includes(uid))
        .map(async (doc) => {
          const conversation = doc.data();

          let participant = null;

          if (conversation.type === "individual") {
            const otherUid = (conversation.members || []).find((id) => id !== uid);

            participant = conversation.memberDetails?.[otherUid] || null;

            if (!participant && otherUid) {
              participant = await buildMemberDetail(db, otherUid);
              // Best-effort backfill — fire and forget, non-blocking
              doc.ref
                .set(
                  { memberDetails: { [otherUid]: participant } },
                  { merge: true }
                )
                .catch((err) =>
                  console.error(
                    `Backfill memberDetails failed for conversation ${doc.id}:`,
                    err
                  )
                );
            }
          }

          return {
            conversationId: conversation.conversationId,
            type: conversation.type,
            lastMessage: conversation.lastMessage,
            lastMessageType: conversation.lastMessageType,
            lastMessageSender: conversation.lastMessageSender,
            lastMessageTime: conversation.lastMessageTime,
            unreadCount: conversation.unreadCount?.[uid] || 0,
            participant,
            members: conversation.members,
          };
        })
    );

    return res.status(200).json({
      success: true,
      total: conversations.length,
      data: conversations,
    });
  } catch (error) {
    console.error("Get Conversations Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Get Conversation By ID (with paginated messages)
 * GET /chat/conversation/:conversationId?before=<messageId>&limit=<n>
 *
 * Supports cursor-based pagination via the `before` query param (a message ID).
 * Returns messages in ascending order (oldest first within the page).
 * Default page size is 50.
 */
exports.getConversationById = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { conversationId } = req.params;
    const { before, limit } = req.query;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID is required.",
      });
    }

    const pageSize = Math.min(
      parseInt(limit, 10) || MESSAGES_PAGE_SIZE,
      100 // hard cap
    );

    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const conversation = conversationDoc.data();

    if (!conversation.members.includes(uid)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to access this conversation.",
      });
    }

    let messagesQuery = conversationRef
      .collection("messages")
      .orderBy("createdAt", "desc") // newest first, then reverse for display
      .limit(pageSize);

    if (before) {
      const cursorDoc = await conversationRef
        .collection("messages")
        .doc(before)
        .get();

      if (cursorDoc.exists) {
        messagesQuery = messagesQuery.startAfter(cursorDoc);
      }
    }

    const messageSnapshot = await messagesQuery.get();

    // Reverse so the response is in ascending (oldest-first) order
    const messages = messageSnapshot.docs
      .map((doc) => ({ messageId: doc.id, ...doc.data() }))
      .reverse();

    // Project only the fields the calling user should see
    const {
      conversationId: cId,
      type,
      members,
      lastMessage,
      lastMessageType,
      lastMessageSender,
      lastMessageTime,
      memberDetails,
    } = conversation;

    return res.status(200).json({
      success: true,
      data: {
        conversation: {
          conversationId: cId,
          type,
          members,
          lastMessage,
          lastMessageType,
          lastMessageSender,
          lastMessageTime,
          memberDetails,
          unreadCount: conversation.unreadCount?.[uid] || 0,
        },
        messages,
        pagination: {
          returned: messages.length,
          hasMore: messages.length === pageSize,
          nextCursor:
            messages.length === pageSize
              ? messages[0]?.messageId || null
              : null,
        },
      },
    });
  } catch (error) {
    console.error("Get Conversation Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Delete Conversation (soft delete for the calling user only)
 * DELETE /chat/conversation/:conversationId
 */
exports.deleteConversation = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID is required.",
      });
    }

    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const conversation = conversationDoc.data();

    if (!conversation.members.includes(uid)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this conversation.",
      });
    }

    await conversationRef.update({
      deletedFor: admin.firestore.FieldValue.arrayUnion(uid),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      message: "Conversation deleted.",
    });
  } catch (error) {
    console.error("Delete Conversation Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Clear Chat — soft-marks a conversation as cleared for the calling user by
 * storing a `clearedAt` timestamp. The client filters out messages with
 * `createdAt <= clearedAt`. This avoids loading and batch-deleting an
 * unbounded number of message documents, which is a memory and billing risk
 * for large conversations.
 *
 * POST /chat/conversation/:conversationId/clear
 */
exports.clearConversationMessages = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID is required.",
      });
    }

    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const conversation = conversationDoc.data();

    if (!conversation.members.includes(uid)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to clear this conversation.",
      });
    }

    // Store a per-user clearedAt timestamp. The client (or API) should filter
    // messages where createdAt <= clearedAt[uid] to implement the cleared view.
    await conversationRef.update({
      [`clearedAt.${uid}`]: admin.firestore.FieldValue.serverTimestamp(),
      [`unreadCount.${uid}`]: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      message: "Chat cleared.",
    });
  } catch (error) {
    console.error("Clear Conversation Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
