export const APPLICATION_CHOICES = {
  adult: ['Ja', 'Nej'],
  license: ['Ja', 'Räknar med att ha det då', 'Nej'],
  weekends: ['Ja', 'Delvis', 'Nej'],
  minimumHours: ['Ja', 'Nej', 'Behöver diskutera'],
  extraShifts: ['Ja', 'Nej', 'Kanske'],
  extension: ['Ja', 'Nej', 'Kanske'],
  car: ['Ja', 'Ibland', 'Nej']
};
export const APPLICATION_LABELS = {
  name:'Namn', email:'E-postadress', phone:'Telefonnummer', location:'Ort',
  adult:'Fyllt 18 år vid start', license:'B-körkort vid start', weekends:'Helgarbete',
  minimumHours:'Minst 10 timmar per månad', transport:'Resa till arbetspassen',
  motivation:'Varför vill du jobba hos oss?', desiredHours:'Önskade timmar per månad',
  unavailable:'Perioder eller helger som inte fungerar', extraShifts:'Extrapass',
  extension:'Fortsättning till 30 september', car:'Tillgång till egen bil', experience:'Erfarenhet'
};
export const APPLICATION_STATUSES = ['Ny ansökan','Behöver kompletteras','Intervju','Praktiskt urval','Erbjudande','Anställd','Reserv','Nej'];
export function validateApplication(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Formulärdata kunde inte läsas.');
  const result = {};
  const limits = { name:100,email:254,phone:30,location:120,transport:500,motivation:1000,desiredHours:100,unavailable:1000,experience:1000 };
  for (const [key,max] of Object.entries(limits)) {
    if (payload[key] != null && typeof payload[key] !== 'string') throw new Error(`${APPLICATION_LABELS[key]} måste vara text.`);
    const value = (payload[key] || '').trim();
    const required = !['desiredHours','unavailable','experience'].includes(key);
    const controls = ['transport','motivation','unavailable','experience'].includes(key) ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/;
    if ((required && !value) || value.length > max || controls.test(value)) throw new Error(`Kontrollera ${APPLICATION_LABELS[key].toLowerCase()} (högst ${max} tecken).`);
    result[key] = value;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Ange en giltig e-postadress.');
  if (!/^\+?\d{7,15}$/.test(result.phone.replace(/[\s().-]/g,''))) throw new Error('Ange ett giltigt telefonnummer.');
  result.email = result.email.toLowerCase();
  for (const [key,values] of Object.entries(APPLICATION_CHOICES)) {
    const value = payload[key] ?? '';
    if (!values.includes(value) && !(value === '' && ['extraShifts','extension','car'].includes(key))) throw new Error(`Välj ett svar för ${APPLICATION_LABELS[key].toLowerCase()}.`);
    result[key] = value;
  }
  return result;
}
