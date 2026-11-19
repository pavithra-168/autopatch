# AutoPatch Firestore Security Specification

## 1. Data Invariants
1. Every top-level project belongs to exactly one authenticated, email-verified user (`userId == request.auth.uid`).
2. Every sub-resource (`files`, `scans`, `bugs`, `patches`, `testResults`, `history`) belongs to an existing parent project owned by `request.auth.uid`, enforced via `get()` on single-document operations and `resource.data.userId == request.auth.uid` on list queries.
3. User PII (`email`, notification toggles) is isolated in `/users/{userId}/private/info` and is readable/writable only by `userId == request.auth.uid`.
4. All document IDs in path variables (`userId`, `projectId`, `fileId`, `scanId`, `bugId`, `patchId`, `resultId`, `historyId`, `notificationId`) must pass `isValidId()` (`^[a-zA-Z0-9_\-]+$`, length 1..128).
5. All `createdAt` / `startedAt` fields must equal `request.time` on creation and remain immutable on update. All `updatedAt` fields must equal `request.time` on update.
6. Every update uses strict action-based `affectedKeys().hasOnly(...)` gates combined with full `isValid[Entity](incoming())` validation.
7. Change history records (`/projects/{projectId}/history/{historyId}`) are append-only (`allow update: if false;`).

## 2. The "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated read/write** on `/projects/proj_1` -> Denied by `isSignedIn()`.
2. **Unverified email write** (`email_verified: false`) on `/projects/proj_1` -> Denied by `isVerifiedUser()`.
3. **ID Poisoning** with path variable `projectId = "bad/../id!"` -> Denied by `isValidId(projectId)`.
4. **Cross-user read** of `/users/other_uid/private/info` -> Denied by `isOwner(userId)`.
5. **Cross-user project spoof** creating `/projects/proj_1` with `userId: "other_uid"` -> Denied by `data.userId == request.auth.uid`.
6. **Shadow / Ghost field injection** (`isAdmin: true` or `role: "admin"`) on `/users/{uid}` -> Denied by `data.keys().hasOnly(...)`.
7. **Timestamp forgery** (`createdAt: "2020-01-01"`) on `/projects/proj_1` -> Denied by `incoming().createdAt == request.time`.
8. **Immutable ownership transfer** updating `userId` on `/projects/proj_1` -> Denied by `incoming().userId == existing().userId` and `affectedKeys().hasOnly(...)`.
9. **Orphaned subcollection write** creating `/projects/nonexistent/bugs/bug_1` -> Denied by `isProjectOwner(projectId)`.
10. **Blanket list scraping** querying `/projects` without `where('userId', '==', uid)` -> Denied by `resource.data.userId == request.auth.uid`.
11. **Oversized payload poisoning** setting `project_name` > 200 chars or `content` > 250000 chars -> Denied by `.size()` bounds.
12. **Audit log tampering** updating `/projects/proj_1/history/hist_1` -> Denied by `allow update: if false;`.
