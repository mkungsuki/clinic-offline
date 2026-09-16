'use strict';
// Paginate in physical mm before printing. Browser table-header repetition can
// disappear when a large-print header exceeds Chromium's page-height threshold.
// Every fragment repeats patient identity AND medicine name; dosage stays literal.
function paginateMedication() {
  window.medicationPaginationReady=false;
  const source=document.querySelector('#medicationSource');
  const output=document.querySelector('#medicationPages');
  const identity=source.querySelector('.identity');
  const medicines=[...source.querySelectorAll('.medicine')];
  output.replaceChildren();
  let page, content;
  function newPage() {
    page=document.createElement('section');page.className='print-page';
    content=document.createElement('div');content.className='page-content';
    content.append(identity.cloneNode(true));page.append(content);output.append(page);
  }
  function fits(el) {return el.getBoundingClientRect().bottom <= content.getBoundingClientRect().bottom-2;}
  newPage();
  for(const medicine of medicines) {
    const original=medicine.querySelector('.instructions').textContent;
    // Grapheme boundaries keep Thai combining marks with their base character.
    const letters=[...new Intl.Segmenter('th',{granularity:'grapheme'}).segment(original)].map(x=>x.segment);
    let start=0, continuation=false;
    let visualTooTall=false;
    while(start<letters.length) {
      const card=medicine.cloneNode(true), text=card.querySelector('.instructions');
      if(continuation)card.querySelector('h2').append(' (ต่อ)');
      function literalFallback() {
        card.querySelector('.dose-visual')?.remove();
        if(!card.querySelector('.text-dose-label')) {
          const label=document.createElement('div');label.className='text-dose-label';
          label.textContent='อ่านตามข้อความ — รายการนี้ยาวเกินแบบภาพ';
          card.querySelector('h2').after(label);
        }
      }
      if(visualTooTall)literalFallback();
      content.append(card);
      text.textContent=letters.slice(start).join('');
      // Move an intact medicine to the next page first, before considering a
      // split. A short remaining space must not split a dosage unnecessarily.
      if(!fits(card) && start===0 && content.querySelectorAll('.medicine').length>1) {
        card.remove();newPage();content.append(card);
      }
      // Keep the complete dose graphic and its literal instructions on one page.
      // If even an empty page cannot hold it, use literal pagination, never a
      // repeated/partial graphic that could be mistaken for another dose.
      if(!fits(card) && card.querySelector('.dose-visual')) {
        visualTooTall=true;literalFallback();
      }
      if(fits(card)) {
        card.dataset.medicineIndex=String(medicines.indexOf(medicine));
        start=letters.length;break;
      }
      if(!fits(card)) {
        const notice=document.createElement('p');notice.className='continuation-notice';
        notice.textContent='วิธีใช้ยังมีต่อหน้าถัดไป กรุณาอ่านให้ครบ';notice.style.fontWeight='bold';
        card.append(notice);
      }
      let lo=0, hi=letters.length-start;
      while(lo<hi) {
        const mid=Math.ceil((lo+hi)/2);text.textContent=letters.slice(start,start+mid).join('');
        if(fits(card))lo=mid;else hi=mid-1;
      }
      if(!lo) {
        card.remove();
        if(!content.querySelector('.medicine'))throw Error('หัวใบยาหรือชื่อยายาวเกินกระดาษนี้ ลอง A4 หรือเลือกตัวอักษร 18 pt แล้วดูตัวอย่างใหม่');
        newPage();continue;
      }
      // Prefer a natural word boundary near the measured page end. If a single
      // token is longer than a page, grapheme splitting still preserves all text.
      if(start+lo<letters.length) {
        const candidate=letters.slice(start,start+lo).join('');
        const words=[...new Intl.Segmenter('th',{granularity:'word'}).segment(candidate)];
        if(words.length>1) {
          const boundary=words[words.length-1].index;
          const count=[...new Intl.Segmenter('th',{granularity:'grapheme'}).segment(candidate.slice(0,boundary))].length;
          if(count>0)lo=count;
        }
      }
      text.textContent=letters.slice(start,start+lo).join('');
      card.dataset.medicineIndex=String(medicines.indexOf(medicine));
      start+=lo;
      if(start<letters.length){continuation=true;newPage();}
    }
  }
  for(const [i,p] of [...output.children].entries()) {
    const footer=document.createElement('div');footer.className='page-counter';
    footer.textContent=`หน้า ${i+1} / ${output.children.length} · ยาที่ได้รับครั้งนี้`;
    p.append(footer);
  }
  window.medicationPaginationReady=true;
}
try {paginateMedication();}
catch(e){document.getElementById('medicationPages').replaceChildren();document.getElementById('printError').textContent=e.message;document.getElementById('printMedication').disabled=true;}
