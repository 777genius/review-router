"""Temporary CI handoff: upload tested Git objects, never update refs or releases."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess

repo = os.environ['GITHUB_REPOSITORY']
expected = os.environ['GITHUB_SHA']
main = '056952b5a3d625fd1d19384942d452114804380f'
assert repo == '777genius/review-router'
assert os.environ['GITHUB_REF'] == 'refs/heads/feat/unified-ocr-review-20261026'


def git(*args):
    return subprocess.check_output(['git', *args])


def api(path, body=None):
    args = ['gh', 'api', f'repos/{repo}/{path}']
    if body is not None:
        args += ['--method', 'POST', '--input', '-']
    result = subprocess.run(args, input=None if body is None else json.dumps(body).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return json.loads(result.stdout)


assert git('rev-parse', 'HEAD').decode().strip() == expected
assert git('rev-parse', 'MERGE_HEAD').decode().strip() == main
assert api('git/ref/heads/feat/unified-ocr-review-20261026')['object']['sha'] == expected
assert not git('ls-files', '-u')
shutil.rmtree('.github/ocr-recovery')
Path('.github/workflows/unified-ocr-sync-main.yml').unlink()
subprocess.run(['git', 'add', '--all'], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
tree = git('write-tree').decode().strip()


def entries(ref):
    result = {}
    for record in git('ls-tree', '-rz', ref).split(b'\0'):
        if not record:
            continue
        info, name = record.split(b'\t', 1)
        mode, kind, sha = info.decode().split()
        result[name.decode()] = {'mode': mode, 'type': kind, 'sha': sha}
    return result


before, upstream, after = entries(expected), entries(main), entries(tree)
known = {entry['sha'] for entry in [*before.values(), *upstream.values()]}
delta = []
for name in sorted(before.keys() | after.keys()):
    if before.get(name) == after.get(name):
        continue
    if name not in after:
        delta.append({'path': name, 'mode': before[name]['mode'], 'type': before[name]['type'], 'sha': None})
        continue
    entry = after[name]
    if entry['sha'] not in known:
        assert entry['type'] == 'blob'
        payload = base64.b64encode(git('cat-file', 'blob', entry['sha'])).decode()
        assert api('git/blobs', {'encoding': 'base64', 'content': payload})['sha'] == entry['sha']
        known.add(entry['sha'])
    delta.append({'path': name, **entry})
remote = api('git/trees', {'base_tree': git('rev-parse', f'{expected}^{{tree}}').decode().strip(), 'tree': delta})['sha']
assert remote == tree
identity = {'name': '777genius', 'email': 'iliyazelenkog@gmail.com'}
commit = api('git/commits', {
    'message': 'merge: integrate current runtime and retain shared OCR dispatch authority\n\nPreserve memory admission, regenerate paired contracts and immutable runtime bundles, and qualify native executables with synthetic external boundaries.',
    'tree': tree, 'parents': [expected, main], 'author': identity, 'committer': identity,
})['sha']
proof = {'expectedHead': expected, 'main': main, 'tree': tree, 'commit': commit,
         'runId': os.environ['GITHUB_RUN_ID'], 'pairedSaas': os.environ['PAIRED_SAAS_SHA']}
out = Path(os.environ['RUNNER_TEMP'], 'ocr-action-integration')
out.mkdir(exist_ok=True)
(out / 'candidate.json').write_text(json.dumps(proof, indent=2))
print('TESTED_CANDIDATE=' + json.dumps(proof), flush=True)
