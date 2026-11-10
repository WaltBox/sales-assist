# Memes for the automatic bump emails

Drop image files here (.jpg, .png, .gif, .webp). The server copies each new one to a public
"memes" folder in Supabase Storage, so it can show inside the email. On the Automatic emails
page, each upcoming bump has one picked; change it or pick "No meme". A company never gets the
same meme twice. Keep them small (under ~500 KB) so the email loads fast.

Text on a meme (11/10): on the Automatic emails page, "Add text" on a meme places up to two text spots on it.
The text can carry {first}, {company} and {rep}, and it's drawn in when the email's image loads, so one picture
serves every rep and every buyer. The spots live in a `<name>.json` beside the file in the bucket.

Yours and everyone's (11/10): a meme you upload is yours alone until you share it. A shared one is on the team
list and in every rep's rotation; whoever shared it (or Walt) can still change, rename, retire or take it back.
