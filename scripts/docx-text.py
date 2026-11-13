import sys
import zipfile
import re

path = sys.argv[1]
z = zipfile.ZipFile(path)
xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# 按段落提取，保留结构
paras = re.findall(r'<w:p[\s>].*?</w:p>', xml, re.S)
lines = []
for para in paras:
    texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', para, re.S)
    line = ''.join(texts).strip()
    if line:
        lines.append(line)

out = '\n'.join(lines)
sys.stdout.reconfigure(encoding='utf-8')
print(out)
