import * as core from "@actions/core";
import {GitHub} from "@actions/github/lib/utils"

type IssueClosure = {
    issue: {
        number: number,
        url: string
    }
    prNumber?: number,
    oid?: string,
}

export async function getClosedIssues(client: InstanceType<typeof GitHub>, repo: string, owner: string, since: Date | null, after: string | null = null): Promise<IssueClosure[]> {
    const returnList: IssueClosure[] = []
    core.debug(`Making graphql request to: ${owner}/${repo} since: ${since?.toISOString()} after: ${after}`)
    const response = await client.graphql<{ [key: string]: any }>(`query($repo: String!, $owner: String!, $since: DateTime, $after: String) { 
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $after, filterBy: {states: [CLOSED], since: $since} ) {
      pageInfo {
        endCursor,
        hasNextPage,
      }
      nodes {
        number,
        url,
        timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
          nodes {
            ... on ClosedEvent {
              closer {
                ... on Commit {
                    oid
                }
                ... on PullRequest {
                    number
                }
              }
            }
          }
        }
      }
    }
  }
}`, {
        repo: repo,
        owner: owner,
        since: since != null ? since.toISOString() : null,
        after: after,
    })
    core.debug(`Retrieved from graphql endpoint: ${JSON.stringify(response)}`)

    returnList.push(...response.repository.issues.nodes
        .filter((node: {[key: string]: any}) => node.timelineItems.nodes[0].closer !== null)
        .map((node: {[key: string]: any}) => ({ issue: { number: node.number, url: node.url }, oid: node.timelineItems.nodes[0].closer.oid, prNumber: node.timelineItems.nodes[0].closer.number })))

    let hasNextPage: boolean = response.repository.issues.pageInfo.hasNextPage;
    if (hasNextPage) {
        returnList.push(...(await getClosedIssues(client, repo, owner, since, response.repository.issues.pageInfo.endCursor)))
    }
    return returnList;
}