# Incremental Review System

## Overview

The incremental review system dramatically reduces review time and cost on PR updates by only reviewing files that have changed since the last review.

**Key Metrics:**

- ⚡ **6x faster** on PR updates (5s vs 30s estimated)
- 💰 **80% cost reduction** on updates
- 📝 **Less spam** - updates existing comment
- 🎯 **Better UX** - shows what's new vs old

## How It Works

### First Review (Full Review)

```
PR opened → Review all 50 files → Post comment → Save state
Cache: { commit: "abc123", findings: [...], timestamp: now }
```

### Subsequent Review (Incremental)

```
PR updated → Check cache → Git diff → Review 3 changed files → Merge findings → Update comment
Cache updated: { commit: "def456", findings: [...], timestamp: now }
```

## Architecture

### Core Components

**IncrementalReviewer** (`src/cache/incremental.ts`)

```typescript
class IncrementalReviewer {
  // Check if incremental review should be used
  async shouldUseIncremental(pr: PRContext): Promise<boolean>

  // Get last review data
  async getLastReview(prNumber: number): Promise<IncrementalCacheData | null>

  // Save review data for next update
  async saveReview(pr: PRContext, review: Review): Promise<void>

  // Get files changed since last review
  async getChangedFilesSince(pr: PRContext, lastCommit: string): Promise<FileChange[]>

  // Merge old + new findings
  mergeFindings(prev: Finding[], new: Finding[], changed: FileChange[]): Finding[]

  // Generate incremental summary
  generateIncrementalSummary(...): string
}
```

### Decision Logic

```typescript
const plan = await incrementalReviewer.planReview(pr);

switch (plan.mode) {
  case IncrementalReviewPlanMode.Full:
    // No compatible completed snapshot: review the current PR inventory.
    break;
  case IncrementalReviewPlanMode.Delta:
    // Review only files changed since the completed snapshot.
    break;
  case IncrementalReviewPlanMode.ReuseCompleted:
    // The exact head is already complete. Skip graph, memory, provider health,
    // and LLM work.
    break;
}
```

`planReview` reads completed state once. The legacy boolean
`shouldUseIncremental` remains a compatibility helper and is true only for the
`Delta` mode; callers that need correct same-head behavior use the tri-state
plan.

### Git Diff Integration

**Important:** Requires full git history for commit comparison. In CI environments:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # Required for incremental review git diff
```

Without full history, `git diff` will fail and automatically fall back to full review.

When GitHub's pull-request files API reaches its 3,000-file ceiling, the hosted
checkout may recover the complete inventory through bounded local
`git diff --name-status --numstat`. Recovery is accepted only for validated
base/head object IDs and when the local count matches GitHub metadata. Missing
history, a count mismatch, command failure, or a safety-limit hit leaves the
review explicitly truncated.

```typescript
async getChangedFilesSince(pr: PRContext, lastCommit: string): FileChange[] {
  // Validate SHAs to prevent command injection
  if (!this.isValidSha(lastCommit) || !this.isValidSha(pr.headSha)) {
    throw new Error('Invalid commit SHA');
  }

  // Run: git diff --name-status <last>...<current>
  // Use execFileSync with array args (secure, prevents shell injection)
  const output = execFileSync('git', ['diff', '--name-status', `${lastCommit}...${pr.headSha}`], {
    encoding: 'utf8',
  });

  // Parse output:
  // M    src/file1.ts
  // A    src/file2.ts
  // D    src/file3.ts

  // Match with PR files to get full FileChange objects
  const changedFiles = output
    .split('\n')
    .map(line => findInPRFiles(line))
    .filter(Boolean);

  return changedFiles; // Only review these!
}
```

### Finding Merge Strategy

```typescript
mergeFindings(previous: Finding[], new: Finding[], changed: FileChange[]): Finding[] {
  const changedFilenames = new Set(changed.map(f => f.filename));

  // Strategy:
  // 1. Keep findings from unchanged files
  const kept = previous.filter(f => !changedFilenames.has(f.file));

  // 2. Add new findings from current review
  const merged = [...kept, ...new];

  // Result: Full picture with old + new
  return merged;
}
```

## Configuration

### Environment Variables

```bash
# Enable/disable incremental reviews
INCREMENTAL_ENABLED=true

# How long to keep cache (1-30 days)
INCREMENTAL_CACHE_TTL_DAYS=7
```

### GitHub Action

```yaml
# .github/workflows/review.yml
- uses: ./
  with:
    INCREMENTAL_ENABLED: 'true'
    INCREMENTAL_CACHE_TTL_DAYS: '7'
```

### YAML Config

```yaml
# .multi-review.yml
incremental_enabled: true
incremental_cache_ttl_days: 7
```

## Cache Structure

### Stored Data

```typescript
interface IncrementalCacheData {
  prNumber: number;
  lastReviewedCommit: string; // Last reviewed SHA
  timestamp: number; // When review happened
  findings: Finding[]; // All findings
  reviewSummary: string; // Full summary text
}
```

### Cache Key

```
incremental-review-pr-{prNumber}
```

Example: `incremental-review-pr-123`

### Storage

Uses the same `CacheStorage` as the main cache:

- GitHub Actions Cache API
- Persists across workflow runs
- Shared within repository

## Output Example

### Incremental Summary

```markdown
## 🔄 Incremental Review

This is an incremental review covering changes from `abc1234` to `def9876`.

**Files reviewed in this update:** 3

- src/auth.ts
- src/middleware/auth.ts
- tests/auth.test.ts

---

## Multi Provider Review Summary

Found 5 issues across 3 files (2 new, 3 from previous review).

### Critical

**src/auth.ts:45** - SQL Injection Vulnerability ⚠️ NEW
Unparameterized SQL query vulnerable to injection.

**Suggestion:** Use parameterized queries with prepared statements.

### Major

**src/config.ts:12** - Missing Error Handling ℹ️ PREVIOUS
No error handling for config file parsing.

...

<details>
<summary>Previous Review Summary</summary>

[Previous full review here]

</details>
```

## Integration Flow

### Orchestrator Integration

```typescript
// src/core/orchestrator.ts
async execute(prNumber: number): Promise<Review | null> {
  const pr = await loadPR(prNumber);

  // Check for incremental
  const useIncremental = await incrementalReviewer.shouldUseIncremental(pr);
  let filesToReview = pr.files;

  if (useIncremental) {
    const lastReview = await incrementalReviewer.getLastReview(pr.number);
    filesToReview = await incrementalReviewer.getChangedFilesSince(
      pr,
      lastReview.lastReviewedCommit
    );
    // Only review changed files!
  }

  // Run review on filesToReview (not all files)
  const review = await reviewFiles(filesToReview);

  if (useIncremental) {
    // Merge with previous findings
    review.findings = incrementalReviewer.mergeFindings(
      lastReview.findings,
      review.findings,
      filesToReview
    );

    // Update summary to show incremental context
    review.summary = incrementalReviewer.generateIncrementalSummary(...);
  }

  // Save for next time
  await incrementalReviewer.saveReview(pr, review);

  // Update existing comment (not create new)
  await commentPoster.postSummary(pr.number, markdown, useIncremental);
}
```

### Comment Update Logic

```typescript
// src/github/comment-poster.ts
async postSummary(prNumber: number, body: string, updateExisting = true) {
  if (updateExisting) {
    const existing = await findBotComment(prNumber);
    if (existing) {
      // Update existing comment
      await octokit.rest.issues.updateComment({
        comment_id: existing.id,
        body: BOT_MARKER + '\n\n' + body
      });
      return;
    }
  }

  // Create new comment
  await octokit.rest.issues.createComment({
    body: BOT_MARKER + '\n\n' + body
  });
}
```

## Performance Comparison

### Scenario: 50-file PR, 3 files changed on update

**Full Review (Without Incremental):**

```
Load PR          →  2s
Review 50 files  → 25s (50 files × 0.5s avg)
Post comments    →  3s
Total: ~30s
Cost: ~$0.015
```

**Incremental Review (With Incremental):**

```
Load PR          →  2s
Git diff         →  0.1s
Review 3 files   →  1.5s (3 files × 0.5s avg)
Merge findings   →  0.1s
Update comment   →  1.3s
Total: ~5s
Cost: ~$0.003
```

**Savings:**

- ⚡ **6x faster** (30s → 5s)
- 💰 **80% cheaper** ($0.015 → $0.003)
- 📝 **No new comment spam**

## Edge Cases Handled

### 1. No Previous Review

```
First review → Full review of all files
```

### 2. Cache Expired

```
Last review > 7 days ago → Full review
```

### 3. No Changes

```
Commit SHA unchanged → Skip review entirely
```

### 4. Git Diff Fails

```
Git error → Fallback to full review of all files
```

### 5. All Files Changed

```
50/50 files changed → Review all files (same as full review)
```

### 6. Comment Update Fails

```
Can't find existing comment → Create new comment
```

## Testing

### Unit Tests (18 tests)

```bash
npm test -- __tests__/unit/cache/incremental.test.ts
```

**Coverage:**

- ✅ shouldUseIncremental logic
- ✅ Cache read/write/parse errors
- ✅ Git diff parsing
- ✅ Finding merge strategy
- ✅ Summary generation
- ✅ Edge cases

### Manual Testing

```bash
# 1. First review
INCREMENTAL_ENABLED=true PR_NUMBER=1 npm start

# 2. Update PR, run again
# Should use incremental review

# 3. Check logs
grep "Incremental review" logs.txt
```

## Limitations

### Current Limitations

1. **Requires Git Access**
   - Needs git repository available
   - Won't work in environments without git

2. **Single PR Tracking**
   - Each PR tracked independently
   - No cross-PR intelligence

3. **Cache Expiry**
   - After TTL days, full review required
   - Can't extend cache for old PRs

4. **Git History Required**
   - Needs commit history available
   - Won't work if commit is squashed/rebased

### Future Improvements

- [ ] Support for squash/rebase (track file hashes)
- [ ] Multi-commit incremental (review each new commit)
- [ ] Configurable merge strategies
- [ ] Smart cache extension (extend TTL on active PRs)
- [ ] Cross-PR learning (similar files)

## Troubleshooting

### "Incremental review disabled"

```
Check: INCREMENTAL_ENABLED=true in config
```

### "No previous review found"

```
Normal on first review. Will be available on next PR update.
```

### "Cache expired"

```
Last review was > TTL days ago. Increase INCREMENTAL_CACHE_TTL_DAYS or run reviews more frequently.
```

### "Git diff failed"

```
Check git repository is available. Falls back to full review.
```

### "All files treated as changed"

```
Git diff may have failed. Check logs for git errors.
```

## Monitoring

### Key Metrics to Track

```typescript
{
  incrementalReviewsUsed: number,
  fullReviewsUsed: number,
  averageFilesReviewed: number,
  cacheHitRate: number,
  timeSaved: number,
  costSaved: number
}
```

### Log Messages

```
[INFO] Incremental review available from abc1234 to def4567
[INFO] Incremental review: reviewing 3 changed files
[INFO] Merged findings: 10 kept from unchanged files, 2 new from review, total 12
[INFO] Saved incremental review data for PR #123 at commit def4567
[INFO] Found existing review comment 456789, updating it
```

## Best Practices

### 1. Enable by Default

```yaml
incremental_enabled: true # On by default
```

### 2. Set Reasonable TTL

```yaml
incremental_cache_ttl_days: 7 # 7 days is good default
```

### 3. Monitor Cache Hit Rate

Track how often incremental is used vs full review.

### 4. Test on Real PRs

Run on active development PRs to validate savings.

### 5. Document for Users

Let users know their PR updates will be faster!

## FAQ

**Q: Does this work on the first review?**
A: No, the first review is always a full review. Incremental kicks in on subsequent updates.

**Q: What happens if I force push?**
A: Git diff will detect all files as changed, resulting in a full review.

**Q: Can I disable incremental for specific PRs?**
A: Yes, set `INCREMENTAL_ENABLED=false` for that run.

**Q: How much cache space does this use?**
A: Minimal - each PR stores ~10-50KB of data (findings + metadata).

**Q: Does it work with draft PRs?**
A: Yes, incremental works for draft PRs if reviews are run on them.

**Q: What if git diff is slow?**
A: Git diff is typically <100ms. If slow, it falls back to full review.

**Q: Can I see what files were reviewed?**
A: Yes, the incremental summary lists all files reviewed in the update.
