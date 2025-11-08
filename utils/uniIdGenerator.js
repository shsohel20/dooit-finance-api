const uniqId = () => {
  const id = Math.floor(Math.random() * Date.now());
  return id;
};

module.exports = uniqId;
