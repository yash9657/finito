#!/usr/bin/env python3
"""Set the local server credential without shell history or terminal echo."""
import getpass
import os
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[1]
target = root / '.env.local'
key = getpass.getpass('Fireworks API key (hidden): ').strip()
if not key or any(ch.isspace() for ch in key) or any(ch in key for ch in '\"\'`$#\\'):
    raise SystemExit('Invalid API key. No files changed.')
text = target.read_text() if target.exists() else ''
updates = {
    'FIREWORKS_API_KEY': key,
    'FIREWORKS_MODEL': 'accounts/fireworks/models/deepseek-v4p1-flash',
}
lines = [line for line in text.splitlines() if line.split('=', 1)[0].strip() not in updates]
lines.extend(f'{name}={value}' for name, value in updates.items())
fd, temporary = tempfile.mkstemp(dir=root, prefix='.fireworks-', suffix='.tmp')
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write('\n'.join(lines) + '\n')
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Saved to .env.local with owner-only permissions. Restart the dev server.')
print('Existing organization model assignments take precedence. Select Fireworks in Settings → Models to migrate an existing workspace.')
