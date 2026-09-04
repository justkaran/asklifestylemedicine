import re

with open("src/App.tsx", "r") as f:
    content = f.read()

content = content.replace("Palonur — no action needed.", "Stanford — no action needed.")
content = content.replace("Palonur (20%)", "Platform (20%)")
content = content.replace("Palonur · {100", "Platform · {100")
content = content.replace("Palonur will process your share automatically each month", "The platform will process your share automatically each month")

with open("src/App.tsx", "w") as f:
    f.write(content)
