# Exam Fee Management — backend integration contract

Implemented 3 November 2026. Backend only; no production deployment, production data migration, SMS sending, or frontend changes.

## Architecture and decisions

Uses existing Express/JWT `protect`/`restrictTo`, CommonJS, Mongoose 7, School/Term/Class/Student/Teacher/User references, and PDFKit. Ordinary School Fees and Feeding Fees restrictions are unchanged. An admin role is required for configuration, authorization, adjustments, reversals, confirmation and reporting; collection uses either an admin or an explicitly authorized teacher. Student, parent and superadmin roles are not granted access to these school-scoped financial APIs.

`School.features.examFeesEnabled` defaults to false for private and government schools. GET/PATCH settings are outside the feature guard; all other routes require it. Disabling retains every financial record but blocks history/receipts too until re-enabled. Existing school-wide restricted/disabled-user behavior is retained through the shared authentication middleware.

All amounts accepted/returned are **integer pesewas**: GHS 50.00 = `5000`. No endpoint accepts a client-supplied school, collector identity, receipt number, paid total or balance. Supported collection and handover methods: `cash`, `mobile_money`, `bank_transfer`, `cheque`. A recorded method is not external provider settlement verification.

### Models

| Model | Purpose and integrity constraints |
|---|---|
| ExamFeeCampaign | Draft/active/closed examination, type `end_of_term` or `mock`, real term and academic year, class-specific amounts and names, activation/closure actor and date. |
| ExamFeeCharge | One school/campaign/student obligation (unique index), original class and student-name snapshots, original/current amount due, net paid, reasoned adjustment history. |
| ExamFeePayment | Immutable payment identity and receipt, collector User and optional Teacher reference, method, recorded/reversed status, time-of-payment balance, reversal metadata and handover allocation counters. Unique school/clientRequestId and global receiptNumber indexes. |
| ExamFeeCollectorAssignment | Unique school/campaign/Teacher-profile/class assignment; grant/revoke actor, status and date. Class-teacher status is irrelevant. |
| ExamFeeRemittance | Per-campaign teacher handover with amount/method, idempotency key, payment allocations, submitted/confirmed/rejected status and administrator confirmation/rejection details. |
| ExamFeeAudit | Append-only application audit events for settings, campaign state, grants/revocations, payment/reversal, charge adjustment and handover actions. No update/delete routes. |

Existing School gains only `features.examFeesEnabled` and internal `examFeesRevision` (write serialization). No new Student, Teacher, Class, Term, User or ordinary financial models.

### Frozen obligations and year handling

A campaign's academicYear must equal its school-scoped Term's canonical `YYYY-YYYY` value. Activation includes enrolled students in the selected classes whose academicYear matches that year (`YYYY-YYYY` or the existing legacy `YYYY to YYYY` format). Graduated and withdrawn students are excluded. A campaign with no eligible students stays draft and returns 409.

Activation atomically generates charges and changes status. Repeat activation of an active campaign returns `alreadyActive: true` and creates nothing. Different mock/end-of-term campaigns have separate charges, including for the same student. Activation freezes the roster and amounts; it does not automatically add late enrolments. Student promotions or class changes do not move an existing charge/payment. Corrections to an existing charge use the explicit adjustment endpoint. No draft edits or reopening are permitted after activation/closure.

### Transactions and reconciliation

Every mutation runs in a MongoDB transaction with snapshot reads and majority writes. The first write increments the authenticated school's `examFeesRevision`. This gives deterministic ordering of feature toggles, assignment revocations, activation, payment, reversal and handover operations within that school; other schools proceed independently. School-level serialization favors financial correctness and is a deliberate throughput tradeoff. Load-test your largest school's collection volume before rollout. Activation streams the roster with batches of 250 inside one atomic transaction; very large rosters may need a future staged activation workflow if they exceed Atlas transaction-duration limits.

Payments also conditionally update the charge only when sufficient balance remains. Idempotency is scoped to school and checked against charge, actor, amount and method. A retry of the same request returns its original payment (including reversed status); reusing its key for a different payload returns 409. Reversal is admin-only with a required reason, updates net paid exactly once, and never deletes the payment. Closed campaigns block new payments but permit history, receipts, adjustments, reversals and handovers.

A submitted handover reserves FIFO amounts from the teacher's recorded payments in one campaign. It supports part of a payment or multiple payments, capped at 1,000 allocations per submission. The server checks net collection minus all previously confirmed/reserved money and chooses the allocations. Client amounts cannot exceed the uncommitted balance. Confirmation moves reserved amounts to remitted amounts atomically; repeating confirmation is a no-op. Rejection releases reservations and requires a reason. A rejected request key remains consumed; use a new key when resubmitting.

Pending handovers must be rejected before reversing a payment allocated to them. Confirmed handovers remain historical even after payment reversal: reports show **over-remitted credit** instead of silently changing money already handed over. That credit reduces future available-to-submit money for the same campaign. No external refund is automatically performed. Outstanding and over-remitted balances are calculated per teacher so one teacher's credit cannot conceal another teacher's debt. Revoked teachers cannot access class lists, receipts or record payments, but can still view their own collection totals and submit their historical unremitted funds.

### Receipts

Download is authorized against the payment's original school/campaign/class. PDF includes school name/logo when readable, student/class, exam, year/term, collected amount, balance and total paid **at the time of that receipt**, method, collection timestamp, unique server-generated reference and collector name. Reversed payments produce a clearly marked REVERSED receipt. Current balances are retrieved through `/charges`; old receipts are not silently rewritten after subsequent payments.

Logo loading permits bounded local uploads or HTTPS Google/Firebase Storage URLs only, with a 3-second timeout, 2 MB cap and no redirects. Missing/unsupported branding is omitted. This prevents arbitrary URL fetches from turning PDF generation into SSRF. PDFKit is an existing dependency.

## HTTP API

Prefix: `/api/exam-fees`. Existing JWT header/cookie authentication. Success JSON starts with `success: true`; errors have `success: false` and a safe `message`. PDF endpoints return `application/pdf` with `private, no-store`. No changes to existing API response shapes.

| Method and path | Access | Purpose / payload |
|---|---|---|
| GET `/settings` | Admin, even disabled | `{examFeesEnabled}` |
| PATCH `/settings` | Admin, even disabled | `{examFeesEnabled: boolean}` |
| POST `/campaigns` | Admin | Create draft; full definition below |
| PATCH `/campaigns/:campaignId` | Admin | Replace draft definition; active/closed rejected |
| POST `/campaigns/:campaignId/activate` | Admin | Generate charges and activate; repeat-safe |
| POST `/campaigns/:campaignId/close` | Admin | Close collections; repeat-safe |
| GET `/campaigns` | Admin/teacher | Paginated campaigns; teacher sees only assigned campaigns/classes |
| POST `/campaigns/:campaignId/assignments` | Admin | `{teacherId, classId}`; teacherId is **Teacher document ID**, not User ID |
| POST `/assignments/:assignmentId/revoke` | Admin | Revoke assignment |
| GET `/assignments` | Admin/teacher | Paginated assignments; teacher sees own active assignments |
| GET `/charges` | Admin/authorized teacher | Student balances; `campaignId` required; `classId` required for teachers |
| POST `/charges/:chargeId/adjustments` | Admin | `{amountDuePesewas, reason}`; new due cannot be below net paid |
| POST `/payments` | Admin/authorized teacher | `{chargeId, amountPesewas, method, clientRequestId}` |
| GET `/payments` | Admin/authorized teacher | Paginated history; includes reversals |
| GET `/payments/:paymentId/receipt` | Admin/authorized teacher | Download PDF |
| POST `/payments/:paymentId/reverse` | Admin | `{reason}` |
| POST `/remittances` | Teacher | `{campaignId, amountPesewas, method, clientRequestId, notes?}` |
| GET `/remittances` | Admin/teacher | Paginated handovers; teacher sees own |
| POST `/remittances/:remittanceId/confirm` | Admin | `{}`; repeat-safe |
| POST `/remittances/:remittanceId/reject` | Admin | `{reason}` |
| GET `/collector-summary` | Admin/teacher | Paginated teacher collection, cash, reversal, confirmed/pending handover, outstanding and credit totals |
| GET `/reports` | Admin | Financial summary and paginated grouped results |
| GET `/audit` | Admin | Paginated audit events |

Example campaign definition:

```json
{
  "name": "BECE Mock 1",
  "examinationType": "mock",
  "academicYear": "2026-2027",
  "termId": "<Term ID>",
  "classFees": [
    {"classId": "<Class ID>", "amountPesewas": 5000},
    {"classId": "<Another Class ID>", "amountPesewas": 7000}
  ]
}
```

All list endpoints use `page` (default 1) and `limit` (default 25, max 100), returning `items`, `total`, `page`, `limit`; most also include `totalPages`. Collection summary returns total but no totalPages. Settings/payment actions wrap their entities as `campaign`, `charge`, `payment`, `assignment` or `remittance`; payment also returns `charge` with server-derived `balancePesewas`, `paymentStatus` and `duplicate`.

Filters:
- Campaigns: `academicYear`, `termId`, `examinationType`, `status`.
- Assignments: `campaignId`.
- Charges: `campaignId`, `classId`, `studentId`, `status=paid|partial|unpaid`.
- Payments: `chargeId` or `campaignId` + `classId` (required for teachers without chargeId), optional `studentId`, admin `teacherId`, `status=recorded|reversed`.
- Remittances: `campaignId`, admin `teacherId`, `status=submitted|confirmed|rejected`.
- Collector summary: `campaignId`, admin `teacherId`. Teachers cannot use these parameters to view another collector.
- Reports: `campaignId`, `academicYear`, `termId`, `examinationType`, `classId`, `groupBy=class|teacher|campaign|examinationType|academicYear|term|method`.
- Audit: `campaignId`.

Report `summary` distinguishes expected obligations, successful net collections, outstanding obligations, cash, reversed amounts/counts, confirmed/pending handovers and per-teacher reconciliation. `groupBy=class` includes billed/paid/outstanding for every charged class, even with no payments. Other groupings show successful collection totals and reversals. Counts of paid/partial/unpaid students are **student-campaign obligations** (`countUnit: student_campaign_charge`); a student charged in two mock exams counts twice in an unfiltered multi-campaign report. Use campaign filters for a single examination roster. Returned integers allow CSV/Excel export clients to display currency safely without recalculating balances.

## Setup and tests

No new runtime dependencies or environment variables. Existing `MONGO_URI`, JWT configuration and MongoDB transaction support are required. Atlas replica sets support transactions. Standalone MongoDB is unsupported; financial operations fail rather than falling back to unsafe non-transactional writes.

Before enabling in a deployed environment, create the new collections/indexes using your reviewed existing connection:

```sh
node scripts/ensureExamFeeIndexes.js --apply
```

This script creates only the six new models' indexes. It does not use `syncIndexes`, delete records, drop indexes or update existing financial data. Existing schools stay disabled by default, without a bulk data migration. **The script has not been run on production.**

The integration test explicitly refuses remote hosts and uses a unique disposable database on a local replica set at port 27183. It does not load `.env` or use production MONGO_URI:

```sh
EXAM_FEES_TEST_URI='mongodb://127.0.0.1:27183/?replicaSet=examFeesTest' node --test tests/examFees.integration.test.js
node --test tests/*.test.js
```

Without the test URI the integration file reports skipped; that is not a transaction test pass. The isolated setup creates the new module indexes explicitly. An existing unrelated Student partial index contains unsupported `$ne` in its partial filter; the test disables automatic legacy index creation instead of modifying that schema. That existing index issue should be reviewed separately.

## Frontend work still required

- Add a separate Exam Fees setting and navigation item for private and government schools; do not reuse ordinary fees gating.
- Build campaign/class amount setup, activation/closure, collector assignment/revocation, charge adjustments and reports.
- Use Teacher profile IDs when granting collection permissions, and server-listed authorized classes in Expo.
- Convert currency input to integer pesewas without binary floating-point rounding; generate and retain a UUID clientRequestId for each attempt until the server resolves it. Retry network failures with the same payload/key.
- Implement partial-payment forms, receipt downloads, history and reversal reason dialogs.
- Implement teacher handover submission and administrator confirm/reject workflow, displaying pending funds and over-remitted credits distinctly.
- Add role/feature-aware visibility and live device/browser acceptance tests, including receipt printing and largest-school activation/collection load tests.
- Do not auto-send SMS or push alerts: notification requirements were not part of this backend phase.

## File inventory

Created:
- `models/ExamFeeCampaign.js`
- `models/ExamFeeCharge.js`
- `models/ExamFeePayment.js`
- `models/ExamFeeCollectorAssignment.js`
- `models/ExamFeeRemittance.js`
- `models/ExamFeeAudit.js`
- `models/examFeeFields.js`
- `middlewares/examFeeMiddleware.js`
- `services/examFees/core.js`
- `services/examFees/campaigns.js`
- `services/examFees/payments.js`
- `services/examFees/remittances.js`
- `services/examFees/reports.js`
- `services/examFees/receipts.js`
- `controllers/examFeeController.js`
- `routes/examFeeRoutes.js`
- `scripts/ensureExamFeeIndexes.js`
- `tests/examFees.integration.test.js`
- `docs/exam-fees-backend.md`

Modified:
- `models/School.js`: independent feature flag and internal transaction revision.
- `server.js`: mounts `/api/exam-fees`.

## Verified results

- Isolated MongoDB 7.0.16 replica-set integration run: **23 tests passed, zero failures/skips** (22 scenarios plus their suite). Exercises real Express routes, JWT middleware, Mongoose models, indexes and MongoDB transactions.
- Existing backend suite: **83 passed, zero failures**, with the new integration suite intentionally skipped in that run because no test database URI was supplied. It was separately executed and passed as above.
- All 17 new runtime/index-script JavaScript files passed Node syntax checks; whitespace checks passed.
- Additive index script verified against a disposable local database, including its explicit `--apply` safeguard.
- PDF downloaded through the authenticated receipt endpoint, extracted for content verification, rendered and visually inspected. One page; aligned columns; correct GHS 20.00 received, GHS 20.00 total paid, GHS 30.00 outstanding example.
- No production database operations, frontend edits or deployment performed.

The local integration harness covers government/private activation, auth and disabled access, cross-school terms/classes/teachers/payments/receipts/reports, drafts and repeat activation, independent mocks, historical classes, multiple-class authorization, unsafe inputs, partial/full payments, concurrent and duplicate payment requests, unique receipts, access revocation, transactional rollback on audit failure, concurrent handovers, partial allocations, repeat confirmation, rejection, mandatory-reason reversal, confirmed-handover credits, explicit charge adjustments, all four methods, report grouping/accuracy, closed campaigns, pagination and retention after disabling.
