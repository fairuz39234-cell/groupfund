const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const encodedPath = (path) =>
  path.split("/").map((part) => encodeURIComponent(part)).join("/");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const easySlipKey = Deno.env.get("EASYSLIP_API_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return reply({ error: "SERVER_CONFIGURATION_ERROR" }, 500);
  }

  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\\s+(.+)$/i)?.[1];
  if (!token) return reply({ error: "UNAUTHENTICATED" }, 401);

  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!authResponse.ok) return reply({ error: "UNAUTHENTICATED" }, 401);
  const user = await authResponse.json();
  if (!user?.id) return reply({ error: "UNAUTHENTICATED" }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "INVALID_REQUEST" }, 400);
  }
  const paymentId = String(body.payment_id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)) {
    return reply({ error: "INVALID_PAYMENT_ID" }, 400);
  }

  const adminHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const paymentUrl = new URL(`${supabaseUrl}/rest/v1/payments`);
  paymentUrl.searchParams.set("select", "id,group_id,collection_item_id,user_id,amount,payment_method,slip_path,status,slip_check_status");
  paymentUrl.searchParams.set("id", `eq.${paymentId}`);
  const paymentResponse = await fetch(paymentUrl, { headers: adminHeaders });
  if (!paymentResponse.ok) return reply({ error: "PAYMENT_LOOKUP_FAILED" }, 502);
  const payments = await paymentResponse.json();
  const payment = payments[0];
  if (!payment || payment.user_id !== user.id) return reply({ error: "PAYMENT_NOT_FOUND" }, 404);
  if (payment.status !== "pending" || payment.payment_method !== "transfer" || !payment.slip_path) {
    return reply({ error: "PAYMENT_NOT_ELIGIBLE" }, 409);
  }
  const slipParts = String(payment.slip_path).split("/");
  if (slipParts.length !== 3 || slipParts[0] !== payment.group_id || slipParts[1] !== user.id || !slipParts[2]) {
    return reply({ error: "INVALID_SLIP_PATH" }, 403);
  }

  const updateCheck = async (status, result, error) => {
    const updateUrl = new URL(`${supabaseUrl}/rest/v1/payments`);
    updateUrl.searchParams.set("id", `eq.${payment.id}`);
    updateUrl.searchParams.set("user_id", `eq.${user.id}`);
    updateUrl.searchParams.set("status", "eq.pending");
    const updated = await fetch(updateUrl, {
      method: "PATCH",
      headers: { ...adminHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        slip_check_status: status,
        slip_check_result: result,
        slip_check_error: error,
        slip_check_at: new Date().toISOString(),
      }),
    });
    return updated.ok;
  };

  if (payment.slip_check_status && payment.slip_check_status !== "not_checked") {
    return reply({ status: payment.slip_check_status });
  }

  const membershipUrl = new URL(`${supabaseUrl}/rest/v1/group_members`);
  membershipUrl.searchParams.set("select", "id");
  membershipUrl.searchParams.set("group_id", `eq.${payment.group_id}`);
  membershipUrl.searchParams.set("user_id", `eq.${user.id}`);
  membershipUrl.searchParams.set("status", "eq.active");
  const memberResponse = await fetch(membershipUrl, { headers: adminHeaders });
  if (!memberResponse.ok || !(await memberResponse.json()).length) {
    return reply({ error: "NOT_AN_ACTIVE_MEMBER" }, 403);
  }

  if (!easySlipKey) {
    await updateCheck("not_configured", null, "EASYSLIP_API_KEY is not set");
    return reply({ status: "not_configured" });
  }

  const objectUrl = `${supabaseUrl}/storage/v1/object/payment-slips/${encodedPath(payment.slip_path)}`;
  const objectResponse = await fetch(objectUrl, { headers: adminHeaders });
  if (!objectResponse.ok) {
    await updateCheck("error", null, "SLIP_FILE_UNAVAILABLE");
    return reply({ status: "error" });
  }
  const mime = (objectResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const fileBlob = await objectResponse.blob();
  if (mime === "application/pdf") {
    await updateCheck("manual_review", null, "PDF_REQUIRES_MANUAL_REVIEW");
    return reply({ status: "manual_review" });
  }
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
    await updateCheck("manual_review", null, "UNSUPPORTED_IMAGE_FORMAT");
    return reply({ status: "manual_review" });
  }
  if (fileBlob.size > 4 * 1024 * 1024) {
    await updateCheck("manual_review", null, "IMAGE_OVER_4_MB");
    return reply({ status: "manual_review" });
  }

  try {
    const form = new FormData();
    form.append("image", new File([fileBlob], "payment-slip", { type: mime }));
    form.append("matchAmount", (Number(payment.amount) / 100).toFixed(2));
    form.append("checkDuplicate", "true");
    const verification = await fetch("https://api.easyslip.com/v2/verify/bank", {
      method: "POST",
      headers: { Authorization: `Bearer ${easySlipKey}` },
      body: form,
    });
    const response = await verification.json();
    if (!verification.ok || !response?.success) {
      const code = String(response?.error?.code || "PROVIDER_ERROR").slice(0, 80);
      const status = code === "SLIP_NOT_FOUND" ? "invalid" : "error";
      await updateCheck(status, null, code);
      return reply({ status, code });
    }

    const data = response.data || {};
    const raw = data.rawSlip || {};
    const rawAmount = Number(data.amountInSlip ?? raw.amount?.amount ?? raw.amount);
    const expectedAmount = Number(payment.amount) / 100;
    const amountMatched = data.isAmountMatched === true ||
      (Number.isFinite(rawAmount) && Math.round(rawAmount * 100) === Number(payment.amount));
    const duplicate = data.isDuplicate === true;
    const result = {
      amountInSlip: Number.isFinite(rawAmount) ? rawAmount : null,
      expectedAmount,
      isAmountMatched: amountMatched,
      isDuplicate: duplicate,
      transactionRef: String(raw.transRef || raw.transactionId || "").slice(0, 100),
      receiverBank: String(raw.receiver?.bank?.name || raw.receiver?.bank?.short || "").slice(0, 100),
      receiverName: String(raw.receiver?.account?.name?.th || raw.receiver?.account?.name?.en || "").slice(0, 160),
    };
    const status = duplicate ? "duplicate" : amountMatched ? "verified" : "mismatch";
    await updateCheck(status, result, null);
    return reply({ status, result });
  } catch {
    await updateCheck("error", null, "PROVIDER_UNAVAILABLE");
    return reply({ status: "error" });
  }
});
