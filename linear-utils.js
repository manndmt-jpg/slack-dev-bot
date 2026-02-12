const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;

/**
 * Fetch recent Linear activity for a team via GraphQL.
 * Returns { newIssues, activeIssues, recentComments }.
 */
async function fetchLinearActivity(apiKey, teamId, sinceHours = 24) {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  const query = `
    query($teamId: String!, $since: DateTimeOrDuration!) {
      team(id: $teamId) {
        issues(
          filter: { updatedAt: { gte: $since } }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            identifier
            title
            state { name }
            assignee { displayName }
            priority
            priorityLabel
            updatedAt
            createdAt
            comments(
              filter: { createdAt: { gte: $since } }
              first: 50
            ) {
              nodes {
                body
                createdAt
                user { name displayName }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables: { teamId, since } }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const issues = json.data.team.issues.nodes;

  // Categorize
  const newIssues = [];
  const activeIssues = [];
  const recentComments = [];

  for (const issue of issues) {
    const created = new Date(issue.createdAt);
    const sinceDate = new Date(since);

    if (created >= sinceDate) {
      newIssues.push(issue);
    } else {
      activeIssues.push(issue);
    }

    // Collect comments with issue context, cap body at 500 chars
    for (const comment of issue.comments.nodes) {
      recentComments.push({
        issue: issue.identifier,
        issueTitle: issue.title,
        author: comment.user?.displayName || comment.user?.name || 'Unknown',
        body: comment.body.length > 500 ? comment.body.slice(0, 500) + '...' : comment.body,
        createdAt: comment.createdAt,
      });
    }
  }

  // Cap comments at 20 most recent across all issues
  recentComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  recentComments.splice(20);

  return { newIssues, activeIssues, recentComments };
}

/**
 * Format Linear data into human-readable text for LLM consumption.
 * authorMap maps Linear display names to preferred short names.
 */
function formatLinearData(data, authorMap = {}) {
  const mapName = (name) => {
    if (!name) return 'Unassigned';
    for (const [key, val] of Object.entries(authorMap)) {
      if (name.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(name.toLowerCase())) {
        return val;
      }
    }
    return name;
  };

  const lines = [];

  if (data.newIssues.length > 0) {
    lines.push('=== NEW ISSUES ===');
    for (const issue of data.newIssues) {
      lines.push(`${issue.identifier}: ${issue.title} — ${issue.state.name} — ${mapName(issue.assignee?.displayName)} [${issue.priorityLabel}]`);
    }
    lines.push('');
  }

  if (data.activeIssues.length > 0) {
    lines.push('=== UPDATED ISSUES ===');
    for (const issue of data.activeIssues) {
      lines.push(`${issue.identifier}: ${issue.title} — ${issue.state.name} — ${mapName(issue.assignee?.displayName)} [${issue.priorityLabel}]`);
    }
    lines.push('');
  }

  if (data.recentComments.length > 0) {
    lines.push('=== RECENT COMMENTS ===');
    for (const c of data.recentComments) {
      lines.push(`[${c.issue}] ${mapName(c.author)}: ${c.body}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { fetchLinearActivity, formatLinearData };
