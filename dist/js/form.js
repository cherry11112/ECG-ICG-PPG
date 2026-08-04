function nextSection(sectionNumber) {
    document.querySelectorAll('.form-section').forEach(section => section.style.display = 'none');
    document.getElementById(`section${sectionNumber}`).style.display = 'block';
  }
  
  function prevSection(sectionNumber) {
    document.querySelectorAll('.form-section').forEach(section => section.style.display = 'none');
    document.getElementById(`section${sectionNumber}`).style.display = 'block';
  }
  

  