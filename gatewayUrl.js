'use strict';

function stripProtoServer(arg0) {
  return String(arg0 || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function shouldUseHttpGateway(arg0) {
  const tmp1 = stripProtoServer(arg0).toLowerCase();
  if (!tmp1) {
    return false;
  }
  const tmp2 = tmp1.replace(/:\d+$/, "");
  if (tmp2 === "127.0.0.1" || tmp2 === "localhost" || tmp2 === "0.0.0.0" || tmp2 === "::1" || tmp2 === "[::1]") {
    return true;
  }
  const tmp3 = tmp1.match(/:(\d+)$/);
  if (tmp3) {
    const tmp4 = Number(tmp3[1]);
    return tmp4 !== 443 && tmp4 !== 80;
  }
  return false;
}

function ensureGatewayUrl(arg0) {
  const tmp1 = String(arg0 || "").trim();
  if (!tmp1) {
    throw new Error("请先填写 Base URL");
  }
  if (/^https?:\/\//i.test(tmp1)) {
    return tmp1;
  }
  const tmp2 = shouldUseHttpGateway(tmp1) ? "http://" : "https://";
  return tmp2 + stripProtoServer(tmp1);
}

function parseProviderBaseUrl(arg0, arg1) {
  const tmp1 = String(arg0 || "").trim();
  if (!tmp1) {
    return {
      input: "",
      host: "",
      apiPath: ""
    };
  }
  const tmp2 = /^https?:\/\//i.test(tmp1) ? tmp1 : "https://" + tmp1;
  let tmp3;
  try {
    tmp3 = new URL(tmp2);
  } catch {
    return {
      input: tmp1,
      host: stripProtoServer(tmp1),
      apiPath: ""
    };
  }
  const tmp4 = String(arg1 || "").trim() || "/messages";
  const tmp5 = tmp4.startsWith("/") ? tmp4 : "/" + tmp4;
  const tmp6 = tmp3.pathname.replace(/\/+$/, "");
  let tmp7 = "";
  if (tmp6 && tmp6 !== "/") {
    tmp7 = tmp6.replace(/\/models$/i, "");
    if (/\/(messages|responses)$/i.test(tmp7)) {
      tmp7 = tmp7.replace(/\/(messages|responses)$/i, "");
    }
    tmp7 = (tmp7 || "/v1") + tmp5;
  }
  return {
    input: tmp1,
    host: tmp3.host,
    apiPath: tmp7
  };
}

module.exports = {
  stripProtoServer,
  shouldUseHttpGateway,
  ensureGatewayUrl,
  parseProviderBaseUrl
};
