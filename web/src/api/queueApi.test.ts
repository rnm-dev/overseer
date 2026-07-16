// The web test script discovers one-directory-deep test files. Keep session
// tests beside their implementation and register them through this entry point.
import "../pages/peon/session/queue.test";
import "../pages/peon/session/submissionGate.test";
import "../pages/peon/session/transcriptMerge.test";
import "../pages/peon/session/transcriptPagination.test";
