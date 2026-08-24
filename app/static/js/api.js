async function apiRequest(method, url, body) {
  const options = {
    method,
    headers: {},
    credentials: "same-origin",
  };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }

  if (!res.ok) {
    const detail = data && data.detail ? data.detail : `요청에 실패했습니다 (${res.status})`;
    const message = typeof detail === "string" ? detail : JSON.stringify(detail);
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

const api = {
  get: (url) => apiRequest("GET", url),
  post: (url, body) => apiRequest("POST", url, body ?? {}),
  put: (url, body) => apiRequest("PUT", url, body ?? {}),
  patch: (url, body) => apiRequest("PATCH", url, body ?? {}),
  del: (url, body) => apiRequest("DELETE", url, body),
};
