export interface User {
  id: number;
  full_name: string;
  email: string;
  profile_image: string;
  preferred_language: string;
  notify_scan_complete: number;
  notify_critical_bugs: number;
  notify_patch_tests: number;
  theme_mode: string;
  created_at: string;
}

export interface Project {
  id: number;
  user_id: number;
  project_name: string;
  description: string;
  programming_language: string;
  source_type: string;
  repository_url: string;
  default_branch: string;
  commit_hash: string;
  project_status: string;
  file_count?: number;
  bug_count?: number;
  fixed_count?: number;
  latest_scan_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectFile {
  id: number;
  project_id: number;
  file_name: string;
  file_path: string;
  file_extension: string;
  file_size: number;
  programming_language: string;
}

export interface ScanJob {
  id: number;
  project_id: number;
  project_name?: string;
  programming_language?: string;
  scan_status: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  current_stage: string;
  progress_percentage: number;
  total_files: number;
  scanned_files: number;
  total_bugs: number;
  started_at: string;
  completed_at?: string | null;
  error_message?: string | null;
}

export interface Bug {
  id: number;
  bug_code: string;
  project_id: number;
  project_name?: string;
  scan_id: number;
  bug_title: string;
  bug_description: string;
  bug_category: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  confidence_score: number;
  analyzer_source: string;
  evidence: string;
  file_path: string;
  start_line: number;
  end_line: number;
  original_code: string;
  root_cause: string;
  why_it_occurs: string;
  triggering_condition: string;
  expected_behavior: string;
  actual_behavior: string;
  potential_impact: string;
  suggested_solution: string;
  bug_status: 'Open' | 'In Review' | 'Patched' | 'Fixed' | 'Dismissed';
  created_at: string;
}

export interface Patch {
  id: number;
  bug_id: number;
  project_id: number;
  bug_code?: string;
  bug_title?: string;
  file_path?: string;
  severity?: string;
  project_name?: string;
  start_line?: number;
  end_line?: number;
  original_code: string;
  proposed_code: string;
  code_diff: string;
  explanation: string;
  repair_reason: string;
  original_file_hash: string;
  patch_status: 'Pending Approval' | 'Approved' | 'Rejected' | 'Applied' | 'Rolled Back';
  validation_status: 'Validation Incomplete' | 'Tests Passed' | 'Tests Failed';
  generated_at: string;
  reviewed_at?: string | null;
}

export interface TestResult {
  id?: number;
  patch_id?: number;
  phase?: 'before' | 'after';
  test_name: string;
  test_description: string;
  test_status: 'Passed' | 'Failed';
  execution_time: number;
  error_message: string;
  output: string;
}

export interface ChangeHistoryItem {
  id: number;
  project_id: number;
  project_name: string;
  bug_id?: number | null;
  bug_code?: string | null;
  bug_title?: string | null;
  patch_id?: number | null;
  patch_status?: string | null;
  validation_status?: string | null;
  action_type: string;
  previous_value: string;
  new_value: string;
  description: string;
  created_at: string;
}

export interface NotificationItem {
  id: number;
  user_id: number;
  title: string;
  message: string;
  notification_type: 'info' | 'success' | 'warning' | 'error';
  is_read: number;
  created_at: string;
}

export interface RecentTaskItem {
  scan_id: number;
  project_id: number;
  project_name: string;
  programming_language: string;
  task_status: 'Analyzing' | 'Patching' | 'Validating' | 'Validated' | 'Completed' | 'Failed';
  current_stage: string;
  progress_percentage: number;
  total_files: number;
  scanned_files: number;
  total_bugs: number;
  fixed_bugs: number;
  started_at: string;
  completed_at?: string | null;
}

export interface LineDiagnosticPatch {
  id: number;
  patch_status: 'Pending Approval' | 'Approved' | 'Rejected' | 'Applied' | 'Rolled Back';
  validation_status: 'Validation Incomplete' | 'Tests Passed' | 'Tests Failed';
  original_code: string;
  proposed_code: string;
  code_diff: string;
  explanation: string;
}

export interface LineDiagnostic {
  bug_id: number;
  bug_code: string;
  bug_title: string;
  bug_description: string;
  bug_category: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  confidence_score: number;
  analyzer_source: string;
  evidence: string;
  start_line: number;
  end_line: number;
  original_code: string;
  root_cause: string;
  suggested_solution: string;
  bug_status: 'Open' | 'In Review' | 'Patched' | 'Fixed' | 'Dismissed';
  is_wrong: boolean;
  latest_patch: LineDiagnosticPatch | null;
}

export interface FileDiagnostic {
  file_name: string;
  file_path: string;
  programming_language: string;
  file_size: number;
  line_count: number;
  status: 'wrong' | 'right' | 'clean';
  error_count: number;
  fixed_count: number;
  wrong_lines: number[];
  right_lines: number[];
  content: string;
  diagnostics: LineDiagnostic[];
  latest_patch: LineDiagnosticPatch | null;
}

export interface ProjectDiagnostics {
  project: {
    id: number;
    project_name: string;
    programming_language: string;
    project_status: string;
  };
  latest_scan: ScanJob | null;
  summary: {
    total_files: number;
    wrong_files_count: number;
    right_files_count: number;
    wrong_lines_count: number;
    fixed_lines_count: number;
    open_bugs_count: number;
    fixed_bugs_count: number;
  };
  files: FileDiagnostic[];
}

export interface DashboardSummary {
  server_time?: string;
  stats: {
    total_projects: number;
    projects_scanned: number;
    bugs_detected: number;
    critical_bugs: number;
    bugs_fixed: number;
    pending_review: number;
  };
  severity_distribution: Array<{ name: string; value: number }>;
  weekly_trend: Array<{ day: string; detected: number; fixed: number }>;
  recent_projects: Project[];
  recent_activities: ChangeHistoryItem[];
  recent_tasks: RecentTaskItem[];
  active_diagnostics?: ProjectDiagnostics | null;
}
