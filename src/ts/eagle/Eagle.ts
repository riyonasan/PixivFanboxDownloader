interface EagleFolder {
  id: string
  name: string
  parent?: string
  children?: EagleFolder[]
}

interface EagleResponse<T> {
  status: string
  data: T
  message?: string
}

interface EagleItemData {
  url: string
  name: string
  website: string
  folderId: string
  headers?: {
    referer: string
  }
}

interface EagleListedItem {
  name: string
  ext: string
  folders: string[]
  isDeleted: boolean
}

// Eagle のローカル API との接続だけを担当する。
class Eagle {
  private readonly apiURL = 'http://localhost:41595/api'
  private folderListPromise: Promise<EagleFolder[]> | null = null
  private readonly folderIdCache = new Map<string, Promise<string>>()
  private readonly folderItemsCache = new Map<
    string,
    Promise<EagleListedItem[]>
  >()
  private cacheScope = ''

  public async addFromURL(
    url: string,
    fileName: string,
    website: string,
    scope: string,
  ) {
    this.resetCache(scope)

    if (url.startsWith('blob:')) {
      throw new Error('Eagle cannot register a blob URL')
    }

    // Eagle cannot download paid FANBOX files with the extension's request
    // headers. Fetch them in the service worker with the browser's cookies and
    // pass the response to Eagle as a data URL instead.
    const eagleURL = await this.getEagleURL(url)
    const folderId = await this.getFolderId(this.getFolderPath(fileName))
    const item: EagleItemData = {
      url: eagleURL,
      name: this.getItemName(fileName),
      website,
      folderId,
      headers: eagleURL.startsWith('data:')
        ? undefined
        : this.getHeaders(website),
    }
    await this.request('item/addFromURL', item)
  }

  public async hasExisting(fileName: string, scope: string) {
    this.resetCache(scope)
    const folders = await this.listFolders()
    let parent: string | undefined
    for (const name of this.getFolderPath(fileName)) {
      const folder = this.findDirectFolder(folders, name, parent)
      if (!folder) {
        return false
      }
      parent = folder.id
    }
    if (!parent) {
      return false
    }
    const folderId = parent

    const finalName = fileName.split('/').pop() || fileName
    const extensionIndex = finalName.lastIndexOf('.')
    const extension =
      extensionIndex > 0 ? finalName.substring(extensionIndex + 1) : ''
    const name = this.getItemName(fileName)
    const items = await this.listFolderItems(folderId)
    return items.some(
      (item) =>
        !item.isDeleted &&
        item.folders.includes(folderId) &&
        this.sameItemName(item.name, name) &&
        item.ext.toLowerCase() === extension.toLowerCase(),
    )
  }

  private sameItemName(actual: string, expected: string) {
    if (actual === expected) {
      return true
    }
    const actualIndex = /^(.*-)(\d+)$/.exec(actual)
    const expectedIndex = /^(.*-)(\d+)$/.exec(expected)
    return !!(
      actualIndex &&
      expectedIndex &&
      actualIndex[1] === expectedIndex[1] &&
      actualIndex[2].replace(/^0+(?=\d)/, '') ===
        expectedIndex[2].replace(/^0+(?=\d)/, '')
    )
  }

  private listFolderItems(folderId: string) {
    let itemsPromise = this.folderItemsCache.get(folderId)
    if (!itemsPromise) {
      itemsPromise = this.fetchFolderItems(folderId).catch((error) => {
        this.folderItemsCache.delete(folderId)
        throw error
      })
      this.folderItemsCache.set(folderId, itemsPromise)
    }
    return itemsPromise
  }

  private async fetchFolderItems(folderId: string) {
    const items: EagleListedItem[] = []
    const limit = 1000
    while (true) {
      const page = await this.request<EagleListedItem[]>(
        `item/list?folders=${encodeURIComponent(folderId)}&limit=${limit}&offset=${items.length}`,
      )
      if (!Array.isArray(page)) {
        throw new Error('Eagle returned an invalid item list')
      }
      items.push(...page)
      if (page.length < limit) {
        return items
      }
    }
  }

  private async getEagleURL(url: string) {
    let parsedURL: URL
    try {
      parsedURL = new URL(url)
    } catch {
      return url
    }

    const hostname = parsedURL.hostname
    if (
      parsedURL.protocol !== 'https:' ||
      (hostname !== 'fanbox.cc' && !hostname.endsWith('.fanbox.cc'))
    ) {
      return url
    }

    let response: Response
    try {
      response = await fetch(url, { credentials: 'include' })
    } catch {
      throw new Error('Unable to download FANBOX file (network error)')
    }
    if (!response.ok) {
      throw new Error(
        `Unable to download FANBOX file (HTTP ${response.status})`,
      )
    }

    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch {
      throw new Error('Unable to read FANBOX file response')
    }

    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(
        ...bytes.subarray(offset, offset + chunkSize),
      )
    }

    const mimeType =
      response.headers.get('content-type') || 'application/octet-stream'
    return `data:${mimeType};base64,${btoa(binary)}`
  }

  private getHeaders(website: string) {
    return { referer: website }
  }

  private getFolderPath(fileName: string) {
    const parts = fileName.split('/').filter((part) => part.length > 0)
    parts.pop()

    // 通常の命名規則には fanbox が含まれるため、Eagle では大文字の
    // FANBOX フォルダをルートとして使う。
    if (parts[0]?.toLowerCase() === 'fanbox') {
      parts.shift()
    }

    return ['FANBOX', ...parts]
  }

  private getItemName(fileName: string) {
    const name = fileName.split('/').pop() || fileName
    const extensionIndex = name.lastIndexOf('.')
    return extensionIndex > 0 ? name.substring(0, extensionIndex) : name
  }

  private async getFolderId(path: string[]) {
    let parent: string | undefined

    for (const name of path) {
      const cacheKey = `${parent || ''}/${name}`
      let folderPromise = this.folderIdCache.get(cacheKey)
      if (!folderPromise) {
        folderPromise = this.findOrCreateFolder(name, parent).catch((error) => {
          this.folderIdCache.delete(cacheKey)
          throw error
        })
        this.folderIdCache.set(cacheKey, folderPromise)
      }
      parent = await folderPromise
    }

    if (!parent) {
      throw new Error('Eagle folder path is empty')
    }
    return parent
  }

  private async findOrCreateFolder(name: string, parent?: string) {
    const folders = await this.listFolders()
    const existing = this.findDirectFolder(folders, name, parent)
    if (existing) {
      return existing.id
    }

    const created = await this.request<EagleFolder>('folder/create', {
      folderName: name,
      ...(parent ? { parent } : {}),
    })
    if (!created || !created.id) {
      throw new Error(`Eagle did not return a folder ID for "${name}"`)
    }

    // 同じ処理中に別の記事から参照された場合も、作成直後のフォルダを
    // 再利用できるように一覧へ反映する。
    if (parent) {
      const parentFolder = this.findFolderById(folders, parent)
      if (parentFolder) {
        parentFolder.children ||= []
        parentFolder.children.push(created)
      }
    } else {
      folders.push(created)
    }
    return created.id
  }

  private listFolders() {
    if (!this.folderListPromise) {
      this.folderListPromise = this.request<EagleFolder[]>('folder/list')
        .then((folders) => folders || [])
        .catch((error) => {
          this.folderListPromise = null
          throw error
        })
    }
    return this.folderListPromise
  }

  private findDirectFolder(
    folders: EagleFolder[],
    name: string,
    parent?: string,
  ) {
    const parentFolder = parent ? this.findFolderById(folders, parent) : null
    const siblings = parent ? parentFolder?.children || [] : folders
    const matches = siblings.filter((folder) => folder.name === name)

    if (matches.length > 1) {
      throw new Error(`Multiple Eagle folders named "${name}" exist`)
    }
    return matches[0]
  }

  private findFolderById(
    folders: EagleFolder[],
    id: string,
  ): EagleFolder | undefined {
    for (const folder of folders) {
      if (folder.id === id) {
        return folder
      }
      const child = folder.children && this.findFolderById(folder.children, id)
      if (child) {
        return child
      }
    }
    return undefined
  }

  private resetCache(scope: string) {
    if (scope === this.cacheScope) {
      return
    }
    this.cacheScope = scope
    this.folderListPromise = null
    this.folderIdCache.clear()
    this.folderItemsCache.clear()
  }

  private async request<T>(path: string, body?: object) {
    const response = await fetch(`${this.apiURL}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let result: EagleResponse<T>
    try {
      result = (await response.json()) as EagleResponse<T>
    } catch {
      throw new Error(
        `Eagle API returned an invalid response (${response.status})`,
      )
    }

    if (!response.ok || result.status !== 'success') {
      throw new Error(
        result.message || `Eagle API request failed (${response.status})`,
      )
    }
    return result.data
  }
}

const eagle = new Eagle()
export { eagle }
