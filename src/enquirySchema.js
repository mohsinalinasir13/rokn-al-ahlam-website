// Single source of truth for the enquiry form: used by the browser form and by
// the server-side relay (server/enquiry-relay.mjs). Pure JS, no JSX/DOM.
export const ENQUIRY_TYPES=[{v:'owner-management',l:'Property Owner / Property Management'},{v:'property-search',l:'Looking for a Property'},{v:'staff-accommodation',l:'Staff Accommodation Requirement'},{v:'vacation-home',l:'Holiday Home Owner'}];
export const HASH_TYPE={'#list':'owner-management','#looking':'property-search','#staff':'staff-accommodation','#vacation':'vacation-home'};
export function etypeLabel(v){for(let i=0;i<ENQUIRY_TYPES.length;i++)if(ENQUIRY_TYPES[i].v===v)return ENQUIRY_TYPES[i].l;return v;}
export const COMMON_HEAD=[{n:'name',l:'Name / Contact Person',t:'text',r:1},{n:'phone',l:'Phone',t:'tel',r:1},{n:'whatsapp',l:'WhatsApp',t:'tel'},{n:'email',l:'Email',t:'email',r:1}];
export const NOTES_F={n:'notes',l:'Additional Notes',t:'textarea'};
export const CONSENT_F={n:'consent',l:'I agree to be contacted about my enquiry.',t:'consent',r:1};
export const EXTRAS={
'owner-management':[{n:'service',l:'Service Required',t:'select',r:1,o:['Property Management','Leasing','Holiday Home','Staff Accommodation','Not Sure']},{n:'ptype',l:'Property Type',t:'select',r:1,o:['Full building','Villa','Apartment','Labour & staff accommodation','Other']},{n:'emirate',l:'Emirate',t:'select',r:1,o:['Dubai','Sharjah','Ajman','Other']},{n:'area',l:'Area / Location',t:'text',r:1},{n:'units',l:'Number of Units / Rooms',t:'text'},{n:'status',l:'Current Status',t:'select',o:['Occupied','Partially occupied','Vacant']},{n:'rent',l:'Expected Rent / Property Value (optional)',t:'text'}],
'property-search':[{n:'intent',l:'Intent',t:'select',r:1,o:['Rent']},{n:'ptype',l:'Property Type',t:'select',r:1,o:['Apartment','Villa','Full building','Staff accommodation','Commercial','Other']},{n:'emirate',l:'Preferred Emirate',t:'select',r:1,o:['Dubai','Sharjah','Ajman','Other']},{n:'area',l:'Preferred Area',t:'text',r:1},{n:'budget',l:'Budget',t:'text'},{n:'timing',l:'Required Timing',t:'select',o:['Immediately','Within 1-3 months','Within 3-6 months','Just researching']}],
'staff-accommodation':[{n:'company',l:'Company Name',t:'text',r:1},{n:'count',l:'Number of Staff',t:'number',r:1},{n:'emirate',l:'Preferred Emirate',t:'select',r:1,o:['Dubai','Sharjah','Ajman','Other']},{n:'area',l:'Preferred Area',t:'text',r:1},{n:'date',l:'Required From',t:'date'},{n:'duration',l:'Expected Duration',t:'text'},{n:'budget',l:'Approximate Budget',t:'text'}],
'vacation-home':[{n:'location',l:'Property Location',t:'text',r:1},{n:'community',l:'Building / Community',t:'text'},{n:'bedrooms',l:'Number of Bedrooms',t:'select',o:['Studio','1','2','3','4','5+']},{n:'furnished',l:'Furnished Status',t:'select',o:['Furnished','Unfurnished']},{n:'occupancy',l:'Current Property Status',t:'text'},{n:'arrangement',l:'Preferred Arrangement',t:'select',o:['Revenue Management','Fixed Rental Arrangement','Not Sure']}]};

export const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function leadError(f,v){const s=(v||'').toString().trim();if(f.t==='consent')return v?'':'Please confirm your consent so we can contact you.';if(f.r&&!s)return f.l+' is required.';if(s&&f.t==='email'&&!EMAIL_RE.test(s))return 'Enter a valid email address.';if(s&&f.t==='tel'&&s.replace(/\D/g,'').length<7)return 'Enter a valid phone number.';return '';}

// Server-side validation. Returns cleaned, length-capped values keyed by field name.
export function validateEnquiry(p){
  const errors={};
  if(!p||typeof p!=='object')return {ok:false,errors:{_:'Invalid request.'},clean:{},type:null};
  const type=p.enquiryType;
  if(typeof type!=='string'||!Object.prototype.hasOwnProperty.call(EXTRAS,type))return {ok:false,errors:{enquiryType:'Unknown enquiry type.'},clean:{},type:null};
  const src=p.fields&&typeof p.fields==='object'?p.fields:{};
  const clean={};
  for(const fd of [...COMMON_HEAD,...EXTRAS[type],NOTES_F]){
    let v=src[fd.n];v=typeof v==='string'?v:(typeof v==='number'?String(v):'');
    v=v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').trim().slice(0,fd.t==='textarea'?3000:500);
    const msg=leadError(fd,v);if(msg)errors[fd.n]=msg;
    else if(v&&fd.t==='select'&&!fd.o.includes(v))errors[fd.n]=fd.l+' has an invalid value.';
    else if(v&&fd.t==='number'&&!/^\d{1,6}$/.test(v))errors[fd.n]=fd.l+' must be a whole number.';
    else if(v&&fd.t==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(v))errors[fd.n]=fd.l+' must be a valid date.';
    clean[fd.n]=v;
  }
  if(p.consent!==true)errors.consent='Please confirm your consent so we can contact you.';
  return {ok:Object.keys(errors).length===0,errors,clean,type};
}
