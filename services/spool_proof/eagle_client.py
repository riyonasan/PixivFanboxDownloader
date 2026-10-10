"""Eagle addFromPath adapter; source downloads and credentials never enter this API."""
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

from fifo import Held, Unavailable, verify_file


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def same_name(actual, expected):
    if actual == expected:
        return True
    left, right = re.fullmatch(r'(.*-)(\d+)', actual), re.fullmatch(r'(.*-)(\d+)', expected)
    return bool(left and right and left[1] == right[1] and int(left[2]) == int(right[2]))


def folder_path(name):
    parts = name.split('/')[:-1]
    if parts and parts[0].lower() == 'fanbox':
        parts.pop(0)
    return ['FANBOX', *parts]


class EagleClient:
    def __init__(self, api_url, token_file, unc_root, library_path, library_mount):
        parsed = urllib.parse.urlsplit(api_url)
        if parsed.scheme != 'http' or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Use the approved private Eagle HTTP endpoint')
        self.api_url = api_url.rstrip('/')
        self.token_file = Path(token_file)
        self.unc_root = unc_root.rstrip('\\/')
        if not self.unc_root.startswith('\\\\'):
            raise ValueError('Use the dedicated UNC share')
        self.library_path, self.library_mount = library_path, Path(library_mount)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, endpoint, payload=None):
        try:
            token = self.token_file.read_text(encoding='utf-8').strip()
            if not token:
                raise Unavailable('eagle_authentication_unavailable')
            # Eagle's private-network API uses the token query parameter.
            separator = '&' if '?' in endpoint else '?'
            url = self.api_url+'/'+endpoint+separator+urllib.parse.urlencode({'token':token})
            data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
            request = urllib.request.Request(url, data, {'Content-Type':'application/json'})
            with self.opener.open(request, timeout=15) as response:
                result = json.load(response)
            if not isinstance(result,dict):
                raise Unavailable('eagle_response_unavailable')
            if result.get('status') != 'success':
                raise Held('eagle_request_rejected')
            return result.get('data')
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            if code in (401,403) or code >= 500:
                raise Unavailable('eagle_unavailable') from None
            raise Held('eagle_request_rejected') from None
        except (OSError, ValueError, TypeError):
            # Never include exception URLs: they contain the API token.
            raise Unavailable('eagle_unavailable') from None

    def ready(self):
        info = self.request('library/info')
        if not isinstance(info, dict) or not isinstance(info.get('library'),dict) or info['library'].get('path') != self.library_path:
            raise Held('eagle_library_changed')
        if not self.library_mount.is_dir():
            raise Unavailable('library_mount_unavailable')
        return self.library_path

    def prepare(self, spec, staged):
        library = self.ready()
        parent = None
        for name in folder_path(spec['fileName']):
            folders = self.request('folder/list')
            if not isinstance(folders,list):
                raise Unavailable('eagle_folders_unavailable')
            def children(items, identifier):
                if identifier is None:
                    return items
                for item in items:
                    if item['id'] == identifier:
                        return item.get('children', [])
                    found = children(item.get('children', []), identifier)
                    if found is not None:
                        return found
                return None
            matches = [item for item in (children(folders, parent) or []) if item['name'] == name]
            if len(matches) > 1:
                raise Held('ambiguous_folder')
            if matches:
                parent = matches[0]['id']
            else:
                created = self.request('folder/create', {'folderName':name, **({'parent':parent} if parent else {})})
                if not isinstance(created, dict) or not created.get('id'):
                    raise Held('folder_not_confirmed')
                parent = created['id']
        final = spec['fileName'].split('/')[-1]
        return {'path':self.unc_root+'\\'+staged.name, 'name':final.rsplit('.',1)[0],
                'website':spec['website'], 'tags':spec['tags'], 'folderId':parent}, library

    def find(self, payload, marker=None):
        items, offset = [], 0
        ext = payload['path'].rsplit('.',1)[-1].lower()
        while True:
            page = self.request('item/list?'+urllib.parse.urlencode({'folders':payload['folderId'],'limit':1000,'offset':offset}))
            if not isinstance(page, list):
                raise Unavailable('eagle_list_unavailable')
            for item in page:
                if not isinstance(item,dict):
                    raise Unavailable('eagle_list_unavailable')
                if item.get('isDeleted') or payload['folderId'] not in item.get('folders', []):
                    continue
                if marker is not None:
                    matches = item.get('annotation') == marker
                else:
                    matches = same_name(item.get('name',''),payload['name']) and item.get('ext','').lower() == ext
                if matches:
                    items.append(item)
            if len(page) < 1000:
                return items
            offset += len(page)

    def verify(self, item, job, payload, library):
        if self.ready() != library:
            raise Held('eagle_library_changed')
        if (not isinstance(item.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]+',item['id'])
                or not same_name(item.get('name',''),payload['name'])
                or re.search(r'[\\/\x00-\x1f]',item['name'])
                or item.get('ext','').lower() != payload['path'].rsplit('.',1)[-1].lower()
                or item.get('size') != job['size'] or item.get('url') != payload['website']
                or payload['folderId'] not in item.get('folders', [])):
            raise Held('eagle_metadata_mismatch')
        # Existing registrations may have user-edited tags; new marked imports must match exactly.
        if payload.get('annotation') and (item.get('annotation') != payload['annotation'] or set(item.get('tags',[])) != set(payload['tags'])):
            raise Held('eagle_metadata_mismatch')
        original = self.library_mount/'images'/(item['id']+'.info')/(item['name']+'.'+item['ext'])
        try:
            verify_file(original, job)
        except OSError:
            raise Unavailable('library_mount_unavailable') from None

    def post(self, payload):
        self.request('item/addFromPath', payload)
