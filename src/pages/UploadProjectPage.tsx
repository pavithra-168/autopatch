import { FileArchive, Github, Loader2, Play, UploadCloud } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { projectService } from '../services/domainServices.ts';

const LANGUAGES = ['Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++'];

export function UploadProjectPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [sourceMode, setSourceMode] = useState<'zip' | 'github'>('zip');
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [projectName, setProjectName] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState('Python');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleFilePick = (file: File | undefined) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    const extMatch = /\.(zip|py|js|jsx|mjs|cjs|ts|tsx|java|c|h|cpp|hpp|cc)$/.exec(lower);
    if (!extMatch) {
      setError('Upload a .zip archive or supported source file (.py, .js, .ts, .java, .c, .cpp).');
      return;
    }
    setError('');
    setSelectedFile(file);
    const extLangMap: Record<string, string> = {
      py: 'Python',
      js: 'JavaScript',
      jsx: 'JavaScript',
      mjs: 'JavaScript',
      cjs: 'JavaScript',
      ts: 'TypeScript',
      tsx: 'TypeScript',
      java: 'Java',
      c: 'C',
      h: 'C',
      cpp: 'C++',
      hpp: 'C++',
      cc: 'C++',
    };
    const detected = extLangMap[extMatch[1]];
    if (detected) {
      setLanguage(detected);
    }
    if (!projectName) {
      setProjectName(file.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    handleFilePick(e.dataTransfer.files?.[0]);
  };

  const handleStartAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    setUploadProgress(0);

    try {
      let projectId: number;
      if (sourceMode === 'zip') {
        if (!selectedFile) {
          throw new Error('Please choose a .zip archive or source file.');
        }
        const form = new FormData();
        form.append('file', selectedFile);
        form.append('project_name', projectName || selectedFile.name.replace(/\.[^.]+$/, ''));
        form.append('description', description);
        form.append('programming_language', language);

        const res = await projectService.uploadZip(form, (pct) => setUploadProgress(pct));
        projectId = res.project.id;
      } else {
        if (!repoUrl.trim()) {
          throw new Error('Please enter a public GitHub repository URL.');
        }
        const res = await projectService.importGithub({
          repository_url: repoUrl.trim(),
          branch: branch.trim() || 'main',
          project_name: projectName.trim(),
          description: description.trim(),
          programming_language: language,
        });
        projectId = res.project.id;
      }

      const { scan } = await projectService.startScan(projectId);
      navigate(`/analysis?scanId=${scan.id}&projectId=${projectId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Project upload failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLoadSample = async () => {
    setError('');
    setSubmitting(true);
    try {
      const res = await projectService.createSample(projectName || 'Student Analytics Core (Python)');
      const { scan } = await projectService.startScan(res.project.id);
      navigate(`/analysis?scanId=${scan.id}&projectId=${res.project.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to create sample project.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout
      title="Upload Project"
      breadcrumb="Projects / New Ingestion"
      action={
        <button
          type="button"
          disabled={submitting}
          onClick={handleLoadSample}
          className="px-4 py-2 text-xs font-semibold text-[#D5AD60] bg-[#111C2D] border border-slate-700 hover:border-[#D5AD60]/60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          <span>Load Sample Python Suite</span>
        </button>
      }
    >
      <div className="max-w-3xl mx-auto">
        <div className="p-6 sm:p-8 rounded-xl bg-[#111C2D] border border-slate-800">
          <div className="flex items-center gap-1 p-1 bg-[#080F1D] rounded-lg border border-slate-800 w-fit mb-6">
            <button
              type="button"
              onClick={() => {
                setSourceMode('zip');
                setError('');
              }}
              className={`px-4 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors ${
                sourceMode === 'zip' ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <FileArchive className="w-3.5 h-3.5" />
              <span>ZIP Archive Upload</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSourceMode('github');
                setError('');
              }}
              className={`px-4 py-2 text-xs font-medium rounded-md inline-flex items-center gap-2 transition-colors ${
                sourceMode === 'github' ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Github className="w-3.5 h-3.5" />
              <span>GitHub Repository</span>
            </button>
          </div>

          {error && (
            <div className="mb-5 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}

          <form onSubmit={handleStartAnalysis} className="space-y-5">
            {sourceMode === 'zip' ? (
              <div>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  className={`p-8 rounded-xl border border-dashed text-center transition-colors ${
                    dragActive
                      ? 'border-[#3B82F6] bg-[#3B82F6]/10'
                      : 'border-slate-700 bg-[#080F1D]'
                  }`}
                >
                  <UploadCloud className="w-9 h-9 text-[#3B82F6] mx-auto mb-3" />
                  <p className="text-sm font-medium text-white">
                    Drag and drop your project .zip archive here
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    Maximum 25 MB · Path traversal validated before extraction
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip,.py,.js,.jsx,.mjs,.cjs,.ts,.tsx,.java,.c,.h,.cpp,.hpp,.cc"
                    className="hidden"
                    onChange={(e) => handleFilePick(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700"
                  >
                    Browse Files
                  </button>

                  {selectedFile && (
                    <div className="mt-4 pt-4 border-t border-slate-800 text-xs text-slate-300 font-mono">
                      {selectedFile.name} · {(selectedFile.size / 1024).toFixed(1)} KB
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Public GitHub Repository URL
                  </label>
                  <input
                    type="url"
                    required
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/owner/repository"
                    className="w-full px-3.5 py-2.5 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Branch</label>
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                    className="w-full px-3.5 py-2.5 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Project Name
                </label>
                <input
                  type="text"
                  required={sourceMode === 'github'}
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="billing-service"
                  className="w-full px-3.5 py-2.5 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Primary Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white focus:outline-none focus:border-[#3B82F6]"
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Project Description
              </label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional summary of modules, runtime targets, or test suites..."
                className="w-full px-3.5 py-2.5 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
              />
            </div>

            {submitting && sourceMode === 'zip' && (
              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-1.5 font-mono tabular-nums">
                  <span>Uploading archive...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 rounded-full bg-[#080F1D] overflow-hidden border border-slate-800">
                  <div
                    className="h-full bg-[#3B82F6] transition-all duration-150"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="px-6 py-2.5 bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors inline-flex items-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{submitting ? 'Processing...' : 'Start Analysis'}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
