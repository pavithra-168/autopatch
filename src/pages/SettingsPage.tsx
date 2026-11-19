import { Loader2, LogOut, Save } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.tsx';
import { auth } from '../firebase.ts';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { authService } from '../services/domainServices.ts';

function formatSettingsError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : fallback;
  try {
    const parsed = JSON.parse(raw) as { error?: string; operationType?: string; path?: string };
    if (parsed && typeof parsed.error === 'string') {
      return parsed.path
        ? `${parsed.error} (${parsed.operationType || 'access'} on ${parsed.path})`
        : parsed.error;
    }
  } catch {
    // Plain error message
  }
  return raw || fallback;
}

export function SettingsPage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState(user?.full_name || '');
  const [preferredLanguage, setPreferredLanguage] = useState(user?.preferred_language || 'Python');
  const [notifyScan, setNotifyScan] = useState(Boolean(user?.notify_scan_complete ?? 1));
  const [notifyCritical, setNotifyCritical] = useState(Boolean(user?.notify_critical_bugs ?? 1));
  const [notifyTests, setNotifyTests] = useState(Boolean(user?.notify_patch_tests ?? 1));
  const [themeMode, setThemeMode] = useState(user?.theme_mode || 'midnight');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [saving, setSaving] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!user) return;
    setFullName(user.full_name || '');
    setPreferredLanguage(user.preferred_language || 'Python');
    setNotifyScan(Boolean(user.notify_scan_complete ?? 1));
    setNotifyCritical(Boolean(user.notify_critical_bugs ?? 1));
    setNotifyTests(Boolean(user.notify_patch_tests ?? 1));
    setThemeMode(user.theme_mode || 'midnight');
  }, [user]);

  const providers = auth.currentUser?.providerData ?? [];
  const isGoogleOnlyAccount =
    providers.some((p) => p.providerId === 'google.com') &&
    !providers.some((p) => p.providerId === 'password');

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg('');
    setErrorMsg('');
    try {
      const res = await authService.updateProfile({
        full_name: fullName,
        preferred_language: preferredLanguage,
        notify_scan_complete: notifyScan,
        notify_critical_bugs: notifyCritical,
        notify_patch_tests: notifyTests,
        theme_mode: themeMode,
      });
      setUser(res.user);
      setStatusMsg('Profile and preferences saved.');
    } catch (err: unknown) {
      setErrorMsg(formatSettingsError(err, 'Unable to save settings.'));
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg('');
    setErrorMsg('');
    if (newPassword.length < 6) {
      setErrorMsg('New password must be at least 6 characters.');
      return;
    }
    setSavingPassword(true);
    try {
      await authService.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setStatusMsg('Account password updated.');
    } catch (err: unknown) {
      setErrorMsg(formatSettingsError(err, 'Failed to update password.'));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <DashboardLayout title="Settings" breadcrumb="Account / Preferences & Security">
      <div className="max-w-3xl space-y-6">
        {statusMsg && (
          <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
            {statusMsg}
          </div>
        )}
        {errorMsg && (
          <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
            {errorMsg}
          </div>
        )}

        <form
          onSubmit={handleSaveProfile}
          className="p-6 rounded-xl bg-[#111C2D] border border-slate-800 space-y-5"
        >
          <div className="flex items-center gap-4 pb-4 border-b border-slate-800">
            <img
              src={user?.profile_image || '/src/assets/images/avatar_developer_default_1795083113786.jpg'}
              alt={user?.full_name || 'Developer'}
              referrerPolicy="no-referrer"
              className="w-14 h-14 rounded-xl object-cover border border-slate-700"
            />
            <div>
              <h2 className="text-base font-display font-semibold text-white">{user?.full_name}</h2>
              <p className="text-xs text-slate-400">{user?.email}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-3.5 py-2 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Preferred Programming Language
              </label>
              <select
                value={preferredLanguage}
                onChange={(e) => setPreferredLanguage(e.target.value)}
                className="w-full px-3.5 py-2 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {['Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++'].map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Notification Preferences
            </label>
            <div className="space-y-2 text-xs text-slate-300">
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={notifyScan}
                  onChange={(e) => setNotifyScan(e.target.checked)}
                  className="rounded border-slate-700 bg-[#080F1D]"
                />
                <span>Notify when project scan completes</span>
              </label>
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={notifyCritical}
                  onChange={(e) => setNotifyCritical(e.target.checked)}
                  className="rounded border-slate-700 bg-[#080F1D]"
                />
                <span>Alert immediately on Critical security or runtime bugs</span>
              </label>
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={notifyTests}
                  onChange={(e) => setNotifyTests(e.target.checked)}
                  className="rounded border-slate-700 bg-[#080F1D]"
                />
                <span>Notify on sandboxed validation test outcomes</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Interface Theme
            </label>
            <select
              value={themeMode}
              onChange={(e) => setThemeMode(e.target.value)}
              className="w-full sm:w-64 px-3.5 py-2 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white"
            >
              <option value="midnight">Midnight Navy (#080F1D)</option>
              <option value="obsidian">High-Contrast Slate</option>
            </select>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              <span>Save Preferences</span>
            </button>
          </div>
        </form>

        <form
          onSubmit={handleChangePassword}
          className="p-6 rounded-xl bg-[#111C2D] border border-slate-800 space-y-4"
        >
          <h2 className="text-base font-display font-semibold text-white">Account Security</h2>
          {isGoogleOnlyAccount ? (
            <p className="text-xs text-slate-400">
              You are signed in with Google. Password and multi-factor authentication settings are managed through your Google Account.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Current Password
                </label>
                <input
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3.5 py-2 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  New Password
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3.5 py-2 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white"
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
              className="px-4 py-2 text-xs font-semibold text-red-300 bg-[#080F1D] border border-red-500/30 rounded-lg inline-flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
            {!isGoogleOnlyAccount && (
              <button
                type="submit"
                disabled={savingPassword}
                className="px-5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-60 border border-slate-700 rounded-lg inline-flex items-center gap-1.5"
              >
                {savingPassword && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Update Password</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
