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

// Eagle のローカル API との接続だけを担当する。
class Eagle {
  private readonly apiURL = 'http://localhost:41595/api'
  private folderListPromise: Promise<EagleFolder[]> | null = null
  private readonly folderIdCache = new Map<string, Promise<string>>()
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

    const folderId = await this.getFolderId(this.getFolderPath(fileName))
    const item: EagleItemData = {
      url,
      name: this.getItemName(fileName),
      website,
      folderId,
      headers: url.startsWith('data:') ? undefined : { referer: website },
    }
    await this.request('item/addFromURL', item)
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
