const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

async function saveMessage(sessionId, role, content) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("conversations")
    .insert({ session_id: sessionId, role, content })
    .select()
    .single();
  if (error) {
    console.error("saveMessage error:", error.message);
    return null;
  }
  return data;
}

async function saveTurn(sessionId, userContent, assistantContent) {
  await saveMessage(sessionId, "user", userContent);
  await saveMessage(sessionId, "assistant", assistantContent);
}

async function getRecentMessages(sessionId, limit = 10) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("getRecentMessages error:", error.message);
    return [];
  }
  return data.reverse();
}

function toClaudeMessages(rows) {
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role, content: r.content }));
}

async function getContext(sessionId, limit = 10) {
  const rows = await getRecentMessages(sessionId, limit);
  return toClaudeMessages(rows);
}

module.exports = {
  supabase,
  saveMessage,
  saveTurn,
  getRecentMessages,
  toClaudeMessages,
  getContext,
};
