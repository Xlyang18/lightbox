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


REMOTE = {}  # path -> (blob_sha, size)，由 load_remote_index() 一次填好


def load_remote_index():
    """一次性取远端文件表。

    不能逐文件 GET /contents/<path>：那会把整个文件的 base64 正文一起返回，
    本机链路读大响应会抛 IncompleteRead(372003 bytes read, ...)，于是 sha 永远拿不到、
    PUT 时缺 sha → 422 "sha wasn't supplied"。
    git/trees 只返回元数据，体积小且一次覆盖全仓。
    """
    r = api('GET', f'/repos/{OWNER}/{REPO}/git/trees/{BRANCH}?recursive=1')
    REMOTE.clear()
    for x in (r.get('tree') or []):
        if x.get('type') == 'blob':
            REMOTE[x['path']] = (x['sha'], x.get('size'))
    return len(REMOTE)


def remote_meta(path):
    return REMOTE.get(path, (None, None))


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
        msg = str(r.get('message'))
        # 索引过期（别人刚改过 / 上一轮部分成功）→ 刷新后重试一次
        if r.get('__error') in (409, 422):
            load_remote_index()
            sha2, _ = remote_meta(rel)
            retry = dict(body)
            if sha2:
                retry['sha'] = sha2
            r = api('PUT', f'/repos/{OWNER}/{REPO}/contents/{q}', retry)
            if not (isinstance(r, dict) and r.get('__error')):
                return 'ok', rel, ''
        return 'fail', rel, f'{r.get("__error")} {msg[:120]}'
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

    n = load_remote_index()
    print(f'远端已有 {n} 个文件', flush=True)

    stats = {'ok': 0, 'same': 0, 'skip': 0, 'fail': 0}
    fails = []
    todo = [f for f in files if f not in done]
    stats['skip'] = total - len(todo)

    # 串行推送：并发时多个请求会带着同一份旧 sha 去 PUT，触发
    # 409 "is at X but expected Y" / 422 "sha wasn't supplied" 竞态
    def serial():
        for rel in todo:
            yield push_one(repo_dir, rel)

    for i, (kind, rel, why) in enumerate(serial(), 1):
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
