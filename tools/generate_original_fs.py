import os
import sys

node_root_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
out_dir = sys.argv[1]
fs_files = sys.argv[2:]

for fs_file in fs_files:
  with open(os.path.join(node_root_dir, fs_file), 'r') as f:
    contents = f.read()
    original_fs_file = fs_file.replace('internal/fs/', 'internal/original-fs/').replace('lib/fs.js', 'lib/original-fs.js').replace('lib/fs/', 'lib/original-fs/')

    with open(os.path.join(out_dir, fs_file), 'w') as original_f:
      original_f.write(contents)

    with open(os.path.join(out_dir, original_fs_file), 'w') as transformed_f:
      transformed_contents = contents.replace('internal/fs/', 'internal/original-fs/').replace('require(\'fs', 'require(\'original-fs')
      transformed_f.write(transformed_contents)
