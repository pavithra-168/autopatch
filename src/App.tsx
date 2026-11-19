import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { BugHistoryPage } from './pages/BugHistoryPage.tsx';
import { BugResultsPage } from './pages/BugResultsPage.tsx';
import { CodeComparisonPage } from './pages/CodeComparisonPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { FinalReportPage } from './pages/FinalReportPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { PatchSuggestionsPage } from './pages/PatchSuggestionsPage.tsx';
import { ProjectAnalysisPage } from './pages/ProjectAnalysisPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { RootCausePage } from './pages/RootCausePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TestingValidationPage } from './pages/TestingValidationPage.tsx';
import { UploadProjectPage } from './pages/UploadProjectPage.tsx';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-[#080F1D] text-slate-300 flex items-center justify-center text-sm">
        Verifying session...
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/upload" element={<ProtectedRoute><UploadProjectPage /></ProtectedRoute>} />
          <Route path="/analysis" element={<ProtectedRoute><ProjectAnalysisPage /></ProtectedRoute>} />
          <Route path="/bugs" element={<ProtectedRoute><BugResultsPage /></ProtectedRoute>} />
          <Route path="/root-cause" element={<ProtectedRoute><RootCausePage /></ProtectedRoute>} />
          <Route path="/patches" element={<ProtectedRoute><PatchSuggestionsPage /></ProtectedRoute>} />
          <Route path="/compare" element={<ProtectedRoute><CodeComparisonPage /></ProtectedRoute>} />
          <Route path="/testing" element={<ProtectedRoute><TestingValidationPage /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute><FinalReportPage /></ProtectedRoute>} />
          <Route path="/history" element={<ProtectedRoute><BugHistoryPage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
