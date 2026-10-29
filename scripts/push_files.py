#!/usr/bin/env python3
"""
把本地 git 仓库的文件逐个推送到 GitHub（Contents API），支持断点续传与并发。

用法: python3 push_files.py <repo_dir> <owner> <repo> [branch]
凭据: ~/.config/doucang-github/token
进度: /tmp/push-<repo>.done

为什么不用 git push：
    本机 github.com 主站不可达，只有 api.github.com 通，所以全程走 REST API。
为什么逐文件推：
    Git Data API 一次性推在本机链路会 socket timeout，逐文件天然可断点续传。
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

OWNER, REPO = None, None
BRANCH = 'main'
API = 'https://api.github.com'


def token():
    with open(os.path.expanduser('~/.config/doucang-github/token')) as f:
        return f.readline().strip()


TOKEN = token()


def api(method, path, body=None, raw=None, content_type='application/json'):
    url = path if path.startswith('http') else API + path
    data = None
    headers = {'Authorization': f'Bearer {TOKEN}', 'User-Agent': 'lightbox-push'}
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = content_type
    elif raw is not None:
        data = raw
        headers['Content-Type'] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                txt = r.read().decode('utf-8', 'replace')
                return json.loads(txt) if txt.strip() else {}
        except urllib.error.HTTPError as e:
            payload = e.read().decode('utf-8', 'replace')
            try:
                parsed = json.loads(payload)
            except Exception:
                parsed = {'message': payload}
            # 502/503/504 与 429 视为暂时性错误，退避重试
            if e.code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            return {'__error': e.code, **parsed}
        except Exception as e:  # 网络抖动
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            return {'__error': -1, 'message': str(e)}
    return {'__error': -1, 'message': 'retries exhausted'}


def remote_meta(path):
    q = urllib.parse.quote(path)
    r = api('GET', f'/repos/{OWNER}/{REPO}/contents/{q}?ref={BRANCH}')
    if isinstance(r, dict) and r.get('sha') and r.get('type') == 'file':
        return r['sha'], r.get('size')
    return None, None


def push_one(repo_dir, rel):
    """返回 (状态, 文件, 说明)。状态 ∈ ok/same/skip/fail"""
    full = os.path.join(repo_dir, rel)
    if not os.path.exists(full):
        return 'fail', rel, '本地不存在'
    size = os.path.getsize(full)
    if size > 45 * 1024 * 1024:
        return 'fail', rel, f'过大 {size}'
    with open(full, 'rb') as f:
        data = f.read()

    sha, rsize = remote_meta(rel)
    # 内容级比对：git blob sha 与远端 sha 一致说明完全没变，省掉一次 PUT
    local_blob = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
    if sha and (local_blob == sha or rsize == size and sha == local_blob):
        return 'same', rel, ''

    body = {
        'message': f'chore: {"更新" if sha else "添加"} {rel}',
        'content': base64.b64encode(data).decode(),
        'branch': BRANCH,
    }
    if sha:
        body['sha'] = sha
    q = urllib.parse.quote(rel)
    r = api('PUT', f'/repos/{OWNER}/{REPO}/contents/{q}', body)
    if isinstance(r, dict) and r.get('__error'):
        return 'fail', rel, f'{r.get("__error")} {str(r.get("message"))[:120]}'
    return 'ok', rel, ''


def main():
    global OWNER, REPO, BRANCH
    repo_dir, OWNER, REPO = sys.argv[1], sys.argv[2], sys.argv[3]
    if len(sys.argv) > 4:
        BRANCH = sys.argv[4]

    os.chdir(repo_dir)
    done_file = f'/tmp/push-{REPO}.done'
    done = set()
    if os.path.exists(done_file):
        with open(done_file) as f:
            done = {x.strip() for x in f if x.strip()}

    # core.quotepath=false：否则中文文件名会被转义加引号，open() 直接找不到文件
    out = subprocess.run(
        ['git', '-c', 'core.quotepath=false', 'ls-files', '-z'],
        capture_output=True,
    ).stdout.decode()
    files = [f for f in out.split('\0') if f and f != '.init']
    total = len(files)
    print(f'待推 {total} 个文件，已完成 {len(done)}', flush=True)

    stats = {'ok': 0, 'same': 0, 'skip': 0, 'fail': 0}
    fails = []
    todo = [f for f in files if f not in done]
    stats['skip'] = total - len(todo)

    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(push_one, repo_dir, rel): rel for rel in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            kind, rel, why = fut.result()
            stats[kind] += 1
            if kind == 'ok':
                with open(done_file, 'a') as f:
                    f.write(rel + '\n')
            elif kind == 'fail':
                fails.append((rel, why))
                print(f'✖ {rel} -> {why}', flush=True)
            if i % 10 == 0 or i == len(todo):
                print(f'  进度 {i}/{len(todo)} {stats}', flush=True)

    print(f'\n完成：上传 {stats["ok"]}，内容未变 {stats["same"]}，已推跳过 {stats["skip"]}，失败 {stats["fail"]}', flush=True)
    for rel, why in fails[:20]:
        print(f'  失败 {rel}: {why}', flush=True)
    sys.exit(1 if stats['fail'] else 0)


if __name__ == '__main__':
    main()
