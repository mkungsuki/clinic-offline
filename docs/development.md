# รันซอร์สและทดสอบ (สำหรับผู้พัฒนา)

ผู้ใช้คลินิกให้ใช้ชุดติดตั้งตาม README หน้านี้สำหรับผู้ที่ดูแล Node.js และ Git ได้แล้วเท่านั้น

ต้องมี Node.js ≥22.5 และ Windows ที่มี Edge ใช้โมดูลในตัว Node ไม่ต้อง npm install ข้อจำกัดของ runtime อาจต่างกัน ควรรัน gate กับ Node ที่จะบรรจุส่งจริงด้วย

เข้าโฟลเดอร์ app แล้วรัน:

```text
npm test
npm run test:http
npm run test:updater
npm run test:browser
```

รัน updater แยกจากชุดทดสอบอื่นเพื่อลดการแย่งพอร์ต/browser ทุก test ต้องใช้ฐานสังเคราะห์ในโฟลเดอร์ชั่วคราว ห้ามใช้ฐานคลินิกหรือยิงคำขอทดสอบเข้าระบบที่เปิดใช้งานจริง

HTTP ต้องเข้าผ่าน npm run test:http เท่านั้น ตัว runner ตรวจ token ยืนยันว่าเป็นระบบชั่วคราว Browser ใช้ Edge profile ใหม่และ LAN IPv4 จริง พร้อม HTTPS; ต้องมี LAN และ Windows Cert provider ที่ใช้งานได้ ถ้าใบรับรองสร้างไม่ได้ ห้ามนับว่า gate ผ่านหรือเปลี่ยนไปใช้ HTTP บน LAN

หากรันจากเครื่องมือที่ใช้ PowerShell 7 แล้ว Windows PowerShell แจ้งว่าไม่พบไดรฟ์ Cert ให้ตรวจ PSModulePath ที่ส่งเข้า subprocess: โมดูลคนละรุ่นอาจปนกัน ลองรันจาก Windows PowerShell ปกติ หรือใช้คำสั่งนี้จาก app เพื่อล้างเฉพาะตัวแปรของ process ทดสอบ (ไม่เปลี่ยนการตั้งค่า Windows ถาวร):

```text
node --no-warnings -e "for(const k of Object.keys(process.env))if(k.toLowerCase()==='psmodulepath')delete process.env[k];require('./test-installer.js')"
```

ยังใช้ใบรับรอง Windows จริงและ assertion เดิมทั้งหมด ไม่ใช้ใบรับรองทดแทนหรือข้ามขั้นทดสอบ

สร้างคู่มือและตรวจตัวติดตั้ง (จาก app):

```text
node tools/build-trial-docs.js
node --no-warnings test-installer.js
```

รัน test-installer ทั้ง PowerShell และ Git Bash ใช้ cmd.exe/PowerShell จริงกับเส้นทางภาษาไทยและช่องว่าง ตรวจ PDF ที่สร้างก่อนรวมชุดส่งมอบ เอกสารต้นฉบับอยู่ ../docs ภาพอยู่ ../docs/screenshots

การสร้างชุด: node tools/build-installer.js และ node tools/build-installer.js --trial สร้างที่ ../dist ต้องตรวจ allowlist/manifest/hash และไม่รวมข้อมูลหรือกุญแจลับ ห้ามเผยแพร่ build ที่ยังไม่ผ่าน gate และอย่าเปลี่ยนกุญแจสาธารณะของโครงการเพื่อข้ามการตรวจลายเซ็น

app/.gitignore กันฐานและข้อมูลลับทั่วไป แต่ไม่แทนการตรวจ git status ทุกครั้ง ห้ามนำ data, ไฟล์สำรอง, รายงานปัญหา, Recovery Kit, กุญแจลับ, output หรือโฟลเดอร์ทดลองเข้าสู่ commit

ซอร์สชุดนี้เป็นสำเนาเผยแพร่ ไม่มีประวัติ repo งาน เครื่องมือ publish-public.js ใช้ฝั่งผู้ดูแลต้นฉบับเพื่อจัดสำเนาทางเดียว ไม่ commit/push เอง หากไม่มี public-release ให้จัดเอกสารในต้นฉบับก่อน ไม่ใช้เครื่องมือนี้ย้ายหรือสำรองข้อมูลคลินิก
