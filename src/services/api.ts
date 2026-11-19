const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api';

const ACCESS_KEY = 'autopatch_access_token';
const REFRESH_KEY = 'autopatch_refresh_token';

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

async function tryRefreshAccessToken(): Promise<string | null> {
  const refresh = getRefreshToken();
  if (!refresh) return null;
  try {
    const res = await fetch(`${resolveApiBase()}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.access_token) {
      localStorage.setItem(ACCESS_KEY, data.access_token);
      return data.access_token;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveApiBase(): string {
  if (API_BASE !== '/api') return API_BASE;
  if (typeof window !== 'undefined') {
    const { hostname, port } = window.location;
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && port && port !== '3000' && port !== '5173') {
      return `http://${hostname}:3000/api`;
    }
  }
  return API_BASE;
}

export function isBackendUnreachableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('Cannot reach the AutoPatch backend API') ||
    err.message.includes('Failed to fetch') ||
    err.message.includes('Backend server did not respond') ||
    err.message.includes('Network error during file upload')
  );
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  retryOn401 = true
): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };

  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const base = resolveApiBase();
  const delays = [400, 900];
  let res: Response | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      res = await fetch(`${base}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers,
      });
      break;
    } catch {
      if (attempt === delays.length) {
        throw new Error(
          'Cannot reach the AutoPatch backend API (/api). Ensure the full-stack server is running via "npm run dev" or "npm start" on port 3000, or continue with Google Cloud Sign-In.'
        );
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }

  if (!res) {
    throw new Error('Backend server did not respond.');
  }

  if (res.status === 401 && retryOn401 && getRefreshToken()) {
    const nextToken = await tryRefreshAccessToken();
    if (nextToken) {
      return apiRequest<T>(path, options, false);
    }
    clearTokens();
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || 'Unexpected server response.' };
  }

  if (!res.ok) {
    throw new Error(String(data.error || data.message || `Request failed (${res.status})`));
  }

  return data as T;
}

function sendXhrUpload<T>(
  url: string,
  formData: FormData,
  token: string | null,
  onProgress: (percent: number) => void
): Promise<{ status: number; data: T | { error?: string; message?: string } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        const parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        resolve({ status: xhr.status, data: parsed });
      } catch {
        resolve({
          status: xhr.status,
          data: { error: xhr.responseText || `Upload failed (${xhr.status})` },
        });
      }
    };
    xhr.onerror = () => reject(new Error('XHR_NETWORK_ERROR'));
    xhr.send(formData);
  });
}

export async function uploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress: (percent: number) => void,
  retryOn401 = true
): Promise<T> {
  const url = `${resolveApiBase()}${path}`;
  const delays = [400, 900];
  let result: { status: number; data: T | { error?: string; message?: string } } | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      result = await sendXhrUpload<T>(url, formData, getAccessToken(), onProgress);
      if ((result.status === 502 || result.status === 503) && attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      break;
    } catch {
      if (attempt === delays.length) {
        throw new Error(
          'Cannot reach the AutoPatch backend API (/api). Ensure the full-stack server is running via "npm run dev" or "npm start" on port 3000, or continue with Google Cloud Sign-In.'
        );
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }

  if (!result) {
    throw new Error('Backend server did not respond.');
  }

  if (result.status === 401 && retryOn401 && getRefreshToken()) {
    const nextToken = await tryRefreshAccessToken();
    if (nextToken) {
      return uploadWithProgress<T>(path, formData, onProgress, false);
    }
    clearTokens();
  }

  if (result.status >= 200 && result.status < 300) {
    return result.data as T;
  }

  const errPayload = result.data as { error?: string; message?: string };
  throw new Error(String(errPayload?.error || errPayload?.message || `Upload failed (${result.status})`));
}

export { API_BASE };
