import {
  Activity,
  Bell,
  Bug as BugIcon,
  CheckCheck,
  FileText,
  FlaskConical,
  GitCompare,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  SearchCode,
  Settings,
  ShieldCheck,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.tsx';
import { reportService } from '../services/domainServices.ts';
import type { NotificationItem } from '../types/autopatch.ts';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/upload', label: 'Upload Project', icon: Upload },
  { to: '/analysis', label: 'Project Analysis', icon: Activity },
  { to: '/bugs', label: 'Bug Detection', icon: BugIcon },
  { to: '/root-cause', label: 'Root Cause', icon: SearchCode },
  { to: '/patches', label: 'AI Patches', icon: Wrench },
  { to: '/compare', label: 'Code Comparison', icon: GitCompare },
  { to: '/testing', label: 'Testing & Validation', icon: FlaskConical },
  { to: '/reports', label: 'Final Report', icon: FileText },
  { to: '/history', label: 'Bug History', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function DashboardLayout({
  title,
  breadcrumb,
  action,
  children,
}: {
  title: string;
  breadcrumb: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const loadNotifications = async () => {
    try {
      const res = await reportService.notifications();
      setNotifications(res.notifications);
    } catch {
      // ignore transient error
    }
  };

  useEffect(() => {
    loadNotifications();
  }, []);

  const unreadCount = notifications.filter((n) => n.is_read === 0).length;

  const handleMarkAllRead = async () => {
    try {
      await reportService.markAllRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
    } catch {
      // ignore transient notification update error
    }
  };

  const handleMarkRead = async (id: number) => {
    try {
      await reportService.markNotificationRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
    } catch {
      // ignore transient notification update error
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[#080F1D] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-[#111C2D] border-r border-slate-800/80">
        <div className="h-16 px-5 flex items-center border-b border-slate-800/80">
          <Link to="/dashboard" className="flex items-center gap-2.5 text-white font-display font-bold text-lg tracking-tight whitespace-nowrap">
            <ShieldCheck className="w-5 h-5 text-[#3B82F6]" />
            <span>AutoPatch</span>
          </Link>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[#3B82F6]/15 text-white border border-[#3B82F6]/30'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                  }`
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="p-4 border-t border-slate-800/80">
          <div className="flex items-center gap-3 mb-3">
            <img
              src={user?.profile_image || '/src/assets/images/avatar_developer_default_1795083113786.jpg'}
              alt={user?.full_name || 'Developer'}
              referrerPolicy="no-referrer"
              className="w-9 h-9 rounded-lg object-cover border border-slate-700 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-100 truncate">{user?.full_name}</p>
              <p className="text-xs text-slate-400 truncate">{user?.email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 bg-[#080F1D] border border-slate-800 rounded-lg hover:text-white hover:border-slate-700 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative w-64 max-w-[80vw] bg-[#111C2D] border-r border-slate-800 flex flex-col z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800">
              <span className="flex items-center gap-2 font-display font-bold text-lg text-white">
                <ShieldCheck className="w-5 h-5 text-[#3B82F6]" />
                AutoPatch
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileNavOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-[#3B82F6]/15 text-white border border-[#3B82F6]/30'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                      }`
                    }
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 px-4 sm:px-8 bg-[#111C2D]/70 backdrop-blur border-b border-slate-800/80 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-400 hover:text-white"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <p className="text-xs text-slate-400 truncate">{breadcrumb}</p>
              <h1 className="text-base sm:text-lg font-display font-semibold text-white truncate">
                {title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {action}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setNotifOpen((v) => !v);
                  if (!notifOpen) loadNotifications();
                }}
                className="relative p-2 rounded-lg border border-slate-800 bg-[#080F1D] text-slate-300 hover:text-white hover:border-slate-700 transition-colors"
                aria-label="Notifications"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#3B82F6] text-[10px] font-mono font-semibold text-white flex items-center justify-center tabular-nums">
                    {unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-[#111C2D] border border-slate-800 rounded-lg shadow-2xl z-40 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">Notifications</span>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={handleMarkAllRead}
                        className="inline-flex items-center gap-1 text-xs text-[#3B82F6] hover:underline"
                      >
                        <CheckCheck className="w-3.5 h-3.5" />
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/70">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-xs text-slate-400">No notifications yet.</p>
                    ) : (
                      notifications.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => handleMarkRead(n.id)}
                          className={`w-full text-left px-4 py-3 hover:bg-slate-800/40 transition-colors ${
                            n.is_read === 0 ? 'bg-[#3B82F6]/5' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-100">{n.title}</span>
                            {n.is_read === 0 && (
                              <span className="text-[11px] font-medium text-[#3B82F6]">New</span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 mt-1">{n.message}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-[1440px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
