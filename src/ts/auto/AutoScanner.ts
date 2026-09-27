import { API } from '../API'
import {
  AutoCreatorProfile,
  AutoPendingPost,
  matchesAutoFee,
} from './AutoTypes'

interface ListedPost {
  id: string
  feeRequired: number
  publishedDatetime: string
}

async function findNewPosts(
  profile: AutoCreatorProfile,
  until: number,
  delayMs: number,
) {
  const pages: { body: { pageUrls: string[] } } = await API.request(
    `https://api.fanbox.cc/post.paginateCreator?creatorId=${encodeURIComponent(profile.creatorId)}`,
  )
  if (!Array.isArray(pages.body?.pageUrls)) {
    throw new Error('FANBOX returned an unexpected page list')
  }

  const result: AutoPendingPost[] = []
  const pageURLs = pages.body.pageUrls.filter((_, index) => index % 30 === 0)
  for (const pageURL of pageURLs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    const url = new URL(pageURL)
    if (url.origin !== 'https://api.fanbox.cc') {
      throw new Error('FANBOX returned an unexpected page URL')
    }
    url.searchParams.set('limit', '300')
    const data: { body: { posts: ListedPost[] } } = await API.request(url.href)
    const posts = data.body?.posts
    if (!Array.isArray(posts)) {
      throw new Error('FANBOX returned an unexpected post list')
    }
    for (const post of posts) {
      const published = Date.parse(post.publishedDatetime)
      if (!Number.isFinite(published)) {
        throw new Error('FANBOX returned an invalid post date')
      }
      if (
        published > profile.since &&
        published <= until &&
        matchesAutoFee(profile, post.feeRequired)
      ) {
        result.push({
          creatorId: profile.creatorId,
          postId: post.id,
          fee: post.feeRequired,
        })
      }
    }
    if (
      posts.length > 0 &&
      posts.every((post) => Date.parse(post.publishedDatetime) <= profile.since)
    ) {
      break
    }
  }
  return result
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.msg !== 'auto_scan') return
  if (
    !message.profile ||
    typeof message.profile.creatorId !== 'string' ||
    typeof message.profile.since !== 'number' ||
    typeof message.until !== 'number'
  ) {
    sendResponse({ error: 'Invalid automatic scan request' })
    return
  }
  void findNewPosts(message.profile, message.until, message.delayMs)
    .then((posts) => sendResponse({ posts }))
    .catch((error) =>
      sendResponse({
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  return true
})
