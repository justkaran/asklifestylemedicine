import re

with open("src/App.tsx", "r") as f:
    content = f.read()

content = content.replace("Contact the Palonur team to\n            restore your access.", "Contact the Stanford team to\n            restore your access.")
content = content.replace('className="inline-block bg-[#8C1515] text-white px-6 py-3 rounded-xl text-sm font-medium hover:bg-[#a01a1a] transition"\n          >\n            Contact Palonur', 'className="inline-block bg-[#8C1515] text-white px-6 py-3 rounded-xl text-sm font-medium hover:bg-[#a01a1a] transition"\n          >\n            Contact Support')

with open("src/App.tsx", "w") as f:
    f.write(content)
