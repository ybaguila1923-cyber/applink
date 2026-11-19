# Security Specification & Payload-First TDD

## 1. Data Invariants
1. **User Profile Isolation**: `/users/{userId}` can only be read or written by `request.auth.uid == userId` with a verified email. `uid` and `createdAt` are immutable.
2. **User Link History Isolation**: `/users/{userId}/links/{linkId}` contains private PII (phone numbers, labels, messages) and is strictly restricted to `request.auth.uid == userId`. `ownerId` and `createdAt` are immutable.
3. **Public Redirect Anti-Scraping**: `/publicRedirects/{shortCode}` allows `get` by exact `shortCode` (validated with `isValidId`) so visitors can follow shortened URLs, while `allow list` is restricted solely to `resource.data.ownerId == request.auth.uid`.
4. **Target URL Safety**: `targetUrl` in both `UserLink` and `PublicRedirect` must start with `https://wa.me/` or `https://api.whatsapp.com/` to prevent open-redirect phishing abuse.
5. **Atomic Click Counting**: Unauthenticated visitors may record a click on `/publicRedirects/{shortCode}/clicks/{clickId}` ONLY when atomically incrementing `/publicRedirects/{shortCode}.clickCount` by exactly `1` in the same batch (`getAfter()` verification), and ONLY when the redirect is `active == true`.
6. **Click Telemetry Read Isolation**: `/publicRedirects/{shortCode}/clicks/{clickId}` `get` and `list` are strictly limited to `resource.data.ownerId == request.auth.uid` (no `get()` calls inside `allow list`).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Shadow Field Injection on UserLink**: Create `/users/u1/links/l1` with extra `isAdmin: true` -> Rejected by `hasOnly(...)`.
2. **Identity Spoofing on UserLink**: User `u2` creates `/users/u1/links/l1` with `ownerId: 'u1'` -> Rejected by `isOwner(userId)` & `data.ownerId == request.auth.uid`.
3. **Timestamp Forgery**: Create `UserLink` with backdated `createdAt` instead of `request.time` -> Rejected by `data.createdAt == request.time`.
4. **Open Redirect Phishing**: Create `PublicRedirect` with `targetUrl: "https://evil.example/login"` -> Rejected by `targetUrl.matches('^https://(wa\\.me|api\\.whatsapp\\.com)/.*')`.
5. **Collection Scraping on PublicRedirects**: Unauthenticated or non-owner queries `list` on `/publicRedirects` -> Rejected (`allow list` requires `resource.data.ownerId == request.auth.uid`).
6. **ID Poisoning**: `get` or `create` on `/publicRedirects/../../etc/passwd` or 500-char string -> Rejected by `isValidId(shortCode)` (`size() <= 32`, alphanumeric/`_`/`-`).
7. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts to create a link -> Rejected by `request.auth.token.email_verified == true`.
8. **Click Count Tampering (Arbitrary Jump)**: Visitor updates `publicRedirects/{shortCode}` setting `clickCount: 999999` -> Rejected (`incoming().clickCount == existing().clickCount + 1`).
9. **Orphan Click / Missing Atomic Increment**: Visitor creates `/publicRedirects/{shortCode}/clicks/c1` without incrementing parent `clickCount` in the same batch -> Rejected by `getAfter(...)`.
10. **Click Owner Spoofing**: Visitor creates click event setting `ownerId` to their own UID to steal analytics -> Rejected (`incoming().ownerId == parent.ownerId`).
11. **Click Telemetry Read Leak**: Non-owner queries `list` on `/publicRedirects/{shortCode}/clicks` -> Rejected (`resource.data.ownerId == request.auth.uid`).
12. **Immutable Field Mutation**: Owner attempts to update `ownerId`, `shortCode`, or `createdAt` on an existing `PublicRedirect` -> Rejected by `affectedKeys().hasOnly(...)` & equality checks.
