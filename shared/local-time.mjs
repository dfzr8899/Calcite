const twoDigits=value=>String(value).padStart(2,'0');

export function localTimestamp(date=new Date()) {
  const day=[String(date.getFullYear()).padStart(4,'0'),twoDigits(date.getMonth()+1),twoDigits(date.getDate())].join('-');
  return day+' '+twoDigits(date.getHours())+twoDigits(date.getMinutes());
}
