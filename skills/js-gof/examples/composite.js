const calculateTotal = (order) => {
  const items = Array.isArray(order) ? order : Object.values(order);
  let total = 0;
  for (const item of items) {
    if (typeof item.price === 'number') total += item.price;
    else total += calculateTotal(item);
  }
  return total;
};

const json = `{
  "electronics": {
    "laptop": { "price": 1200 },
    "accessories": {
      "mouse": { "price": 25 },
      "keyboard": { "price": 75 }
    }
  },
  "books": {
    "fiction": { "price": 15 },
    "technical": { "price": 60 }
  }
}`;

const order = JSON.parse(json);
const total = calculateTotal(order);

module.exports = { calculateTotal, order, total };
