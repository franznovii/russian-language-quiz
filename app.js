"use strict";

// DEMO ONLY. No backend, database, analytics or persistence.
// These sample questions and answer keys are PUBLIC and must be removed
// before production. In production, validate answers only in GAS.
const SAMPLE_QUESTIONS = [
  {
    text: "Какой вариант написан правильно?",
    kind: "Один правильный ответ",
    options: ["В течение недели", "В течении недели", "На протяжение недели", "В теченье недели"],
    correct: [0],
    explanation: "Предлог «в течение» со значением времени пишется раздельно и с Е на конце."
  },
  {
    text: "В каком слове ударение поставлено верно?",
    kind: "Один правильный ответ",
    options: ["звОнит", "тОрты", "катАлог", "красивЕе"],
    correct: [1],
    explanation: "Норма: звонИт, тОрты, каталОг, красИвее."
  },
  {
    text: "Какие сочетания написаны правильно?",
    kind: "Несколько правильных ответов",
    description: "Выбери ВСЕ правильные варианты. Для зачёта нужно отметить полный набор, без лишних ответов.",
    options: ["Вследствие дождя", "В течении дня", "Насчёт поездки", "По мере возможности"],
    correct: [0, 2, 3],
    explanation: "«Вследствие» в значении причины и «насчёт» в значении «о» пишутся слитно; «по мере» — раздельно. Предлог времени — «в течение дня»."
  },
  {
    text: "В каком предложении нужна запятая?",
    kind: "Один правильный ответ",
    options: ["Мы вышли и дождь закончился.", "Он купил яблоки и груши.", "Вечером начался сильный дождь.", "Она улыбнулась и кивнула."],
    correct: [0],
    explanation: "В предложении «Мы вышли, и дождь закончился» две грамматические основы, поэтому между частями нужна запятая."
  },
  {
    text: "В каком слове пишется НН?",
    kind: "Один правильный ответ",
    options: ["ветреный", "кожаный", "стеклянный", "румяный"],
    correct: [2],
    explanation: "«Стеклянный» — одно из исключений (вместе с «оловянный» и «деревянный»), в которых пишется НН."
  },
  {
    text: "Где НЕ пишется раздельно?",
    kind: "Один правильный ответ",
    options: ["(не)навидеть", "(не)смотря на дождь", "(не)был дома", "(не)вежда"],
    correct: [2],
    explanation: "С глаголом «был» частица НЕ пишется отдельно: «не был дома»."
  }
];

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
try {
  if (tg) { tg.ready(); tg.expand(); }
} catch (err) {
  // Browser demo still works if Telegram features are unavailable.
}

const screens = {
  intro: document.getElementById("screen-intro"),
  quiz: document.getElementById("screen-quiz"),
  result: document.getElementById("screen-result")
};
const counter = document.getElementById("question-counter");
const title = document.getElementById("question-title");
const description = document.getElementById("question-description");
const kind = document.getElementById("question-kind");
const choices = document.getElementById("choices");
const progress = document.getElementById("progress-fill");
const progressTrack = document.querySelector(".progress-track");
const feedback = document.getElementById("feedback");
const answerButton = document.getElementById("answer-btn");

let index = 0;
let score = 0;
let selected = new Set();
let verified = false;

function showScreen(name) {
  Object.keys(screens).forEach(function (key) { screens[key].hidden = key !== name; });
  window.scrollTo(0, 0);
}

function isCorrect(question) {
  return selected.size === question.correct.length &&
    question.correct.every(function (i) { return selected.has(i); });
}

function renderQuestion() {
  const question = SAMPLE_QUESTIONS[index];
  selected = new Set();
  verified = false;
  counter.textContent = "Вопрос " + (index + 1) + " из " + SAMPLE_QUESTIONS.length;
  kind.textContent = question.kind;
  title.textContent = question.text;
  description.hidden = !question.description;
  description.textContent = question.description || "";
  progress.style.width = String((index / SAMPLE_QUESTIONS.length) * 100) + "%";
  progressTrack.setAttribute("aria-valuenow", String(index));
  feedback.hidden = true;
  feedback.className = "feedback";
  feedback.textContent = "";
  answerButton.disabled = true;
  answerButton.innerHTML = 'Проверить ответ <span aria-hidden="true">→</span>';
  choices.replaceChildren();

  question.options.forEach(function (option, optionIndex) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    button.setAttribute("aria-pressed", "false");
    const marker = document.createElement("span");
    marker.className = "choice-marker";
    marker.textContent = String.fromCharCode(65 + optionIndex);
    marker.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "choice-text";
    text.textContent = option;
    button.append(marker, text);
    button.addEventListener("click", function () { toggleChoice(optionIndex); });
    choices.appendChild(button);
  });
  showScreen("quiz");
}

function toggleChoice(optionIndex) {
  if (verified) return;
  const question = SAMPLE_QUESTIONS[index];
  if (question.correct.length === 1) {
    selected = new Set([optionIndex]);
  } else if (selected.has(optionIndex)) {
    selected.delete(optionIndex);
  } else {
    selected.add(optionIndex);
  }
  Array.from(choices.children).forEach(function (button, i) {
    const active = selected.has(i);
    button.classList.toggle("is-selected", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  answerButton.disabled = selected.size === 0;
}

function verifyAnswer() {
  if (verified || selected.size === 0) return;
  const question = SAMPLE_QUESTIONS[index];
  const correct = isCorrect(question);
  if (correct) score += 1;
  verified = true;
  Array.from(choices.children).forEach(function (button, i) {
    button.disabled = true;
    if (question.correct.includes(i)) button.classList.add("is-correct");
    else if (selected.has(i)) button.classList.add("is-incorrect");
  });
  feedback.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = correct ? "Точно в цель!" : "Есть над чем подумать.";
  const explanation = document.createElement("p");
  explanation.textContent = question.explanation;
  feedback.append(heading, explanation);
  feedback.classList.toggle("is-wrong", !correct);
  feedback.hidden = false;
  answerButton.innerHTML = index === SAMPLE_QUESTIONS.length - 1 ?
    'Посмотреть результат <span aria-hidden="true">→</span>' :
    'Следующий вопрос <span aria-hidden="true">→</span>';
}

function showResult() {
  progressTrack.setAttribute("aria-valuenow", String(SAMPLE_QUESTIONS.length));
  document.getElementById("score-value").textContent = String(score);
  const message = score === 6 ?
    "Безупречно. Корректор уже нервно листает словарь." :
    score >= 4 ?
    "Очень неплохо. Русский язык пока на твоей стороне." :
    score >= 2 ?
    "Русский язык любит сюрпризы. И ты только что встретил несколько." :
    "Опечатка судьбы? В следующий раз возьмём реванш.";
  document.getElementById("result-title").textContent = score === 6 ? "Вот это грамотность." : "Проверка окончена.";
  document.getElementById("result-message").textContent = message;
  showScreen("result");
}

document.getElementById("start-btn").addEventListener("click", function () {
  score = 0;
  index = 0;
  renderQuestion();
});
document.getElementById("again-btn").addEventListener("click", function () {
  score = 0;
  index = 0;
  renderQuestion();
});
answerButton.addEventListener("click", function () {
  if (!verified) {
    verifyAnswer();
  } else if (index < SAMPLE_QUESTIONS.length - 1) {
    index += 1;
    renderQuestion();
  } else {
    showResult();
  }
});
